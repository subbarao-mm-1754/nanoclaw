/**
 * Install / manage NanoClaw gateway + worker as separate OS services.
 * Supports role=both|gateway|worker for same-host or split-machine deploys.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../src/log.js';
import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import {
  commandExists,
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from '../platform.js';
import { emitStatus } from '../status.js';
import {
  distEntry,
  getLaunchdServiceLabel,
  getSystemdServiceUnit,
  getSystemdTargetUnit,
  type ServiceKind,
} from './names.js';
import { resolveRole, rolesToInstall, type NanoclawRole } from './roles.js';
import { buildLaunchdPlist, buildSystemdTarget, buildSystemdUnit } from './templates.js';
import { ensureOnecliRunning } from './ensure-onecli.js';

export type InstallResult = {
  role: NanoclawRole;
  kinds: ServiceKind[];
  serviceType: 'launchd' | 'systemd-user' | 'systemd-system' | 'nohup';
  labels: string[];
};

function ensureBuilt(projectRoot: string): void {
  log.info('Building TypeScript');
  try {
    execSync('pnpm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.info('Build succeeded');
  } catch {
    log.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  for (const kind of ['gateway', 'worker'] as const) {
    const entry = path.join(projectRoot, distEntry(kind));
    if (!fs.existsSync(entry)) {
      log.error('Missing build output', { entry });
      emitStatus('SETUP_SERVICE', {
        SERVICE_TYPE: 'unknown',
        PROJECT_PATH: projectRoot,
        STATUS: 'failed',
        ERROR: `missing_${kind}_entry`,
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
  }
}

function unloadLegacyClassicHost(projectRoot: string, platform: string): void {
  // Old setup pointed at dist/index.js — unload so it doesn't fight gateway/worker.
  if (platform === 'macos') {
    const label = getLaunchdLabel(projectRoot);
    const plistPath = path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    );
    try {
      execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
      log.info('Unloaded legacy classic-host launchd service', { label });
    } catch {
      // not loaded
    }
    return;
  }

  if (platform === 'linux' && hasSystemd()) {
    const unit = getSystemdUnit(projectRoot);
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} stop ${unit}`, { stdio: 'ignore' });
      execSync(`${prefix} disable ${unit}`, { stdio: 'ignore' });
      log.info('Stopped legacy classic-host systemd unit', { unit });
    } catch {
      // not present
    }
  }
}

function killOrphans(projectRoot: string, kinds: ServiceKind[]): void {
  for (const kind of kinds) {
    const entry = distEntry(kind).replace(/\//g, '\\/');
    try {
      execSync(`pkill -f '${projectRoot}/${entry}' || true`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false;
  } catch {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

function maybeFixDockerAcl(): boolean {
  let stale = !isRoot() && checkDockerGroupStale();
  if (!stale) return false;
  log.warn(
    'Docker group not active in systemd session — user was likely added to docker group mid-session',
  );
  if (!commandExists('setfacl')) {
    log.warn('setfacl not installed — cannot apply automatic workaround');
    return true;
  }
  const user = execSync('whoami', { encoding: 'utf-8' }).trim();
  try {
    execSync(`sudo setfacl -m u:${user}:rw /var/run/docker.sock`, {
      stdio: 'inherit',
    });
    log.info(
      'Applied temporary ACL to /var/run/docker.sock (resets on docker restart or reboot)',
    );
    return false;
  } catch (err) {
    log.warn('Failed to apply setfacl workaround', { err });
    return true;
  }
}

function installLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  kinds: ServiceKind[],
): InstallResult {
  const labels: string[] = [];
  for (const kind of kinds) {
    const label = getLaunchdServiceLabel(kind, projectRoot);
    const plistPath = path.join(
      homeDir,
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    );
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(
      plistPath,
      buildLaunchdPlist({ kind, projectRoot, nodePath, homeDir }),
    );
    log.info('Wrote launchd plist', { kind, plistPath });

    try {
      execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
    } catch {
      // noop
    }
    try {
      execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
      log.info('launchctl load succeeded', { label });
    } catch (err) {
      log.error('launchctl load failed', { label, err });
    }
    labels.push(label);
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    SERVICE_LABELS: labels.join(','),
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });

  return { role: resolveRole(), kinds, serviceType: 'launchd', labels };
}

function installSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  kinds: ServiceKind[],
): InstallResult {
  const runningAsRoot = isRoot();
  let unitDir: string;
  let systemctlPrefix: string;
  let wantedBy: string;
  let serviceType: InstallResult['serviceType'];

  if (runningAsRoot) {
    unitDir = '/etc/systemd/system';
    systemctlPrefix = 'systemctl';
    wantedBy = 'multi-user.target';
    serviceType = 'systemd-system';
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      log.warn('systemd user session not available — falling back to nohup wrapper');
      return installNohup(projectRoot, nodePath, homeDir, kinds);
    }
    unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    systemctlPrefix = 'systemctl --user';
    wantedBy = 'default.target';
    serviceType = 'systemd-user';
  }

  const dockerGroupStale = kinds.includes('worker') ? maybeFixDockerAcl() : false;
  killOrphans(projectRoot, kinds);

  if (!runningAsRoot) {
    try {
      execSync('loginctl enable-linger', { stdio: 'ignore' });
      log.info('Enabled loginctl linger for current user');
    } catch (err) {
      log.warn('loginctl enable-linger failed — service may stop on SSH logout', { err });
    }
  }

  const labels: string[] = [];
  const gatewayUnit =
    kinds.includes('gateway') && kinds.includes('worker')
      ? `${getSystemdServiceUnit('gateway', projectRoot)}.service`
      : undefined;

  for (const kind of kinds) {
    const unitName = getSystemdServiceUnit(kind, projectRoot);
    const unitPath = path.join(unitDir, `${unitName}.service`);
    const afterUnits =
      kind === 'worker' && gatewayUnit ? [gatewayUnit] : [];
    fs.writeFileSync(
      unitPath,
      buildSystemdUnit({
        kind,
        projectRoot,
        nodePath,
        homeDir,
        wantedBy,
        afterUnits,
      }),
    );
    log.info('Wrote systemd unit', { unitPath });
    labels.push(unitName);

    try {
      execSync(`${systemctlPrefix} enable ${unitName}`, { stdio: 'ignore' });
    } catch (err) {
      log.error('systemctl enable failed', { unitName, err });
    }
  }

  // Target for `systemctl start nanoclaw-v2-<slug>` when both roles on one host
  if (kinds.length === 2) {
    const targetName = getSystemdTargetUnit(projectRoot);
    const targetPath = path.join(unitDir, `${targetName}.target`);
    fs.writeFileSync(
      targetPath,
      buildSystemdTarget({ projectRoot, kinds, wantedBy }),
    );
    try {
      execSync(`${systemctlPrefix} enable ${targetName}.target`, { stdio: 'ignore' });
    } catch (err) {
      log.warn('systemctl enable target failed', { targetName, err });
    }
    labels.push(`${targetName}.target`);
  }

  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl daemon-reload failed', { err });
  }

  for (const kind of kinds) {
    const unitName = getSystemdServiceUnit(kind, projectRoot);
    try {
      execSync(`${systemctlPrefix} restart ${unitName}`, { stdio: 'ignore' });
    } catch (err) {
      log.error('systemctl restart failed', { unitName, err });
    }
  }

  const active: string[] = [];
  for (const kind of kinds) {
    const unitName = getSystemdServiceUnit(kind, projectRoot);
    try {
      execSync(`${systemctlPrefix} is-active ${unitName}`, { stdio: 'ignore' });
      active.push(unitName);
    } catch {
      // not active
    }
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: serviceType,
    SERVICE_UNITS: labels.join(','),
    ACTIVE: active.join(','),
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    LINGER_ENABLED: !runningAsRoot,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });

  return { role: resolveRole(), kinds, serviceType, labels };
}

function installNohup(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  kinds: ServiceKind[],
): InstallResult {
  log.warn('No systemd detected — generating nohup wrapper scripts');
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  const wrappers: string[] = [];
  for (const kind of kinds) {
    const wrapperPath = path.join(projectRoot, `start-${kind}.sh`);
    const pidFile = path.join(projectRoot, `${kind}.pid`);
    const entry = path.join(projectRoot, distEntry(kind));
    const outLog = path.join(projectRoot, 'logs', `${kind}.log`);
    const errLog = path.join(projectRoot, 'logs', `${kind}.error.log`);

    const lines = [
      '#!/bin/bash',
      `# start-${kind}.sh — Start NanoClaw ${kind} without systemd`,
      `# To stop: kill \\$(cat ${pidFile})`,
      '',
      'set -euo pipefail',
      '',
      `cd ${JSON.stringify(projectRoot)}`,
      '',
      `if [ -f ${JSON.stringify(pidFile)} ]; then`,
      `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
      '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
      `    echo "Stopping existing ${kind} (PID $OLD_PID)..."`,
      '    kill "$OLD_PID" 2>/dev/null || true',
      '    sleep 2',
      '  fi',
      'fi',
      '',
      `echo "Starting NanoClaw ${kind}..."`,
      `NANOCLAW_ROLE=${kind} nohup ${JSON.stringify(nodePath)} ${JSON.stringify(entry)} \\`,
      `  >> ${JSON.stringify(outLog)} \\`,
      `  2>> ${JSON.stringify(errLog)} &`,
      '',
      `echo $! > ${JSON.stringify(pidFile)}`,
      `echo "NanoClaw ${kind} started (PID $!)"`,
      `echo "Logs: tail -f ${outLog}"`,
    ];
    fs.writeFileSync(wrapperPath, lines.join('\n') + '\n', { mode: 0o755 });
    wrappers.push(wrapperPath);
    log.info('Wrote nohup wrapper', { wrapperPath });
  }

  if (kinds.length === 2) {
    const allPath = path.join(projectRoot, 'start-zclaw.sh');
    const body = [
      '#!/bin/bash',
      'set -euo pipefail',
      `ROOT=${JSON.stringify(projectRoot)}`,
      '"$ROOT/start-gateway.sh"',
      '"$ROOT/start-worker.sh"',
    ].join('\n') + '\n';
    fs.writeFileSync(allPath, body, { mode: 0o755 });
    wrappers.push(allPath);
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATHS: wrappers.join(','),
    HOME: homeDir,
    SERVICE_LOADED: false,
    FALLBACK: isWSL() ? 'wsl_no_systemd' : 'no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });

  return {
    role: resolveRole(),
    kinds,
    serviceType: 'nohup',
    labels: wrappers,
  };
}

/**
 * Install OS services for the configured role and start them.
 */
export function installServices(roleArg?: string): InstallResult {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const role = resolveRole(roleArg);
  const kinds = rolesToInstall(role);

  log.info('Setting up NanoClaw services', { platform, role, kinds, nodePath, projectRoot });

  ensureBuilt(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  unloadLegacyClassicHost(projectRoot, platform);
  ensureOnecliRunning(projectRoot);

  if (platform === 'macos') {
    return installLaunchd(projectRoot, nodePath, homeDir, kinds);
  }
  if (platform === 'linux') {
    if (getServiceManager() === 'systemd') {
      return installSystemd(projectRoot, nodePath, homeDir, kinds);
    }
    return installNohup(projectRoot, nodePath, homeDir, kinds);
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'unknown',
    PROJECT_PATH: projectRoot,
    STATUS: 'failed',
    ERROR: 'unsupported_platform',
    LOG: 'logs/setup.log',
  });
  process.exit(1);
}

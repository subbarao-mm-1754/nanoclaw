/**
 * Start / stop / restart / status for gateway + worker OS services.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getPlatform, getServiceManager, isRoot } from '../platform.js';
import {
  getLaunchdServiceLabel,
  getSystemdServiceUnit,
  getSystemdTargetUnit,
  type ServiceKind,
} from './names.js';
import { resolveRole, rolesToInstall } from './roles.js';

export type CtlAction = 'start' | 'stop' | 'restart' | 'status';

function systemctlPrefix(): string {
  return isRoot() ? 'systemctl' : 'systemctl --user';
}

function run(cmd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const out = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n').trim();
    return { ok: false, out: out || err.message || 'failed' };
  }
}

function launchdPlistPath(kind: ServiceKind, projectRoot: string): string {
  const label = getLaunchdServiceLabel(kind, projectRoot);
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function ctlLaunchd(action: CtlAction, kinds: ServiceKind[], projectRoot: string): number {
  let failed = 0;
  for (const kind of kinds) {
    const plist = launchdPlistPath(kind, projectRoot);
    const label = getLaunchdServiceLabel(kind, projectRoot);
    if (!fs.existsSync(plist)) {
      console.error(`[${kind}] plist missing — run: nanoclaw service install`);
      failed++;
      continue;
    }
    if (action === 'status') {
      const list = run('launchctl list');
      const loaded = list.out.includes(label);
      console.log(`${kind}: ${loaded ? 'loaded' : 'not loaded'} (${label})`);
      continue;
    }
    if (action === 'stop') {
      const r = run(`launchctl unload ${JSON.stringify(plist)}`);
      console.log(`${kind}: ${r.ok ? 'stopped' : 'stop failed — ' + r.out}`);
      if (!r.ok) failed++;
      continue;
    }
    // start / restart
    run(`launchctl unload ${JSON.stringify(plist)}`);
    const r = run(`launchctl load ${JSON.stringify(plist)}`);
    console.log(`${kind}: ${r.ok ? 'started' : 'start failed — ' + r.out}`);
    if (!r.ok) failed++;
  }
  return failed;
}

function ctlSystemd(action: CtlAction, kinds: ServiceKind[], projectRoot: string): number {
  const prefix = systemctlPrefix();
  let failed = 0;

  if (action === 'status') {
    for (const kind of kinds) {
      const unit = getSystemdServiceUnit(kind, projectRoot);
      const r = run(`${prefix} is-active ${unit}`);
      const en = run(`${prefix} is-enabled ${unit}`);
      console.log(`${kind}: ${r.out || 'unknown'} (enabled=${en.ok ? en.out : 'no'}) [${unit}]`);
    }
    return 0;
  }

  if (kinds.length === 2 && (action === 'start' || action === 'stop' || action === 'restart')) {
    const target = `${getSystemdTargetUnit(projectRoot)}.target`;
    // Prefer target when both roles; fall through to per-unit if target missing
    const tryTarget = run(`${prefix} ${action} ${target}`);
    if (tryTarget.ok || action === 'stop') {
      // For stop, also stop units explicitly in case target alone didn't
      if (action === 'stop') {
        for (const kind of kinds) {
          run(`${prefix} stop ${getSystemdServiceUnit(kind, projectRoot)}`);
        }
      }
      if (tryTarget.ok) {
        console.log(`target: ${action} ok (${target})`);
        return 0;
      }
    }
  }

  // Ordered: gateway before worker on start/restart; reverse on stop
  const ordered =
    action === 'stop' ? [...kinds].reverse() : kinds;

  for (const kind of ordered) {
    const unit = getSystemdServiceUnit(kind, projectRoot);
    const r = run(`${prefix} ${action} ${unit}`);
    console.log(`${kind}: ${r.ok ? action + ' ok' : action + ' failed — ' + r.out}`);
    if (!r.ok) failed++;
  }
  return failed;
}

function ctlNohup(action: CtlAction, kinds: ServiceKind[], projectRoot: string): number {
  let failed = 0;
  for (const kind of kinds) {
    const pidFile = path.join(projectRoot, `${kind}.pid`);
    const wrapper = path.join(projectRoot, `start-${kind}.sh`);

    if (action === 'status') {
      let state = 'stopped';
      if (fs.existsSync(pidFile)) {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        const alive = run(`kill -0 ${pid}`);
        state = alive.ok ? `running (pid ${pid})` : 'stale pid file';
      }
      console.log(`${kind}: ${state}`);
      continue;
    }

    if (action === 'stop' || action === 'restart') {
      if (fs.existsSync(pidFile)) {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        run(`kill ${pid}`);
        try {
          fs.unlinkSync(pidFile);
        } catch {
          // ignore
        }
        console.log(`${kind}: stopped`);
      } else {
        console.log(`${kind}: not running`);
      }
    }

    if (action === 'start' || action === 'restart') {
      if (!fs.existsSync(wrapper)) {
        console.error(`[${kind}] missing ${wrapper} — run: nanoclaw service install`);
        failed++;
        continue;
      }
      const r = run(`bash ${JSON.stringify(wrapper)}`);
      console.log(`${kind}: ${r.ok ? 'started' : 'start failed — ' + r.out}`);
      if (!r.ok) failed++;
    }
  }
  return failed;
}

export function runCtl(action: CtlAction, roleArg?: string): number {
  const projectRoot = process.cwd();
  const role = resolveRole(roleArg);
  const kinds = rolesToInstall(role);
  const platform = getPlatform();

  console.log(`NanoClaw ${action} (role=${role}, kinds=${kinds.join('+')})`);

  if (platform === 'macos') {
    return ctlLaunchd(action, kinds, projectRoot);
  }
  if (platform === 'linux') {
    if (getServiceManager() === 'systemd') {
      return ctlSystemd(action, kinds, projectRoot);
    }
    return ctlNohup(action, kinds, projectRoot);
  }
  console.error(`Unsupported platform: ${platform}`);
  return 1;
}

export function showLogs(kind: ServiceKind | 'all', follow: boolean): number {
  const projectRoot = process.cwd();
  const kinds: ServiceKind[] =
    kind === 'all' ? ['gateway', 'worker'] : [kind];
  const files = kinds.flatMap((k) => [
    path.join(projectRoot, 'logs', `${k}.log`),
    path.join(projectRoot, 'logs', `${k}.error.log`),
  ]);
  const existing = files.filter((f) => fs.existsSync(f));
  if (existing.length === 0) {
    console.error('No log files yet. Start services first.');
    return 1;
  }
  const cmd = follow
    ? `tail -n 80 -F ${existing.map((f) => JSON.stringify(f)).join(' ')}`
    : `tail -n 80 ${existing.map((f) => JSON.stringify(f)).join(' ')}`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    return 0;
  } catch {
    return 1;
  }
}

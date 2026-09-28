/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { log } from '../src/log.js';
import { getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';
import {
  getLaunchdServiceLabel,
  getSystemdServiceUnit,
} from './services/names.js';
import { resolveRole, rolesToInstall } from './services/roles.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const role = resolveRole();
  const kinds = rolesToInstall(role);

  log.info('Starting verification', { role, kinds });

  // 1. Check gateway/worker service status + checkout mismatch.
  let service:
    | 'not_found'
    | 'stopped'
    | 'running'
    | 'running_other_checkout' = 'not_found';
  let runningFromPath: string | null = null;
  const mgr = getServiceManager();
  const kindStates: Record<string, string> = {};

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      let anyFound = false;
      let allRunning = true;
      for (const kind of kinds) {
        const label = getLaunchdServiceLabel(kind, projectRoot);
        const line = output.split('\n').find((l) => l.includes(label));
        if (!line) {
          kindStates[kind] = 'not_found';
          allRunning = false;
          continue;
        }
        anyFound = true;
        const pidField = line.trim().split(/\s+/)[0];
        if (pidField !== '-' && pidField) {
          kindStates[kind] = 'running';
          const pid = Number(pidField);
          if (!runningFromPath && Number.isInteger(pid) && pid > 0) {
            runningFromPath = resolveBinaryScript(pid);
          }
        } else {
          kindStates[kind] = 'stopped';
          allRunning = false;
        }
      }
      service = !anyFound ? 'not_found' : allRunning ? 'running' : 'stopped';
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    let anyFound = false;
    let allRunning = true;
    for (const kind of kinds) {
      const unit = getSystemdServiceUnit(kind, projectRoot);
      try {
        execSync(`${prefix} is-active ${unit}`, { stdio: 'ignore' });
        kindStates[kind] = 'running';
        anyFound = true;
        if (!runningFromPath) {
          try {
            const pidStr = execSync(
              `${prefix} show ${unit} -p MainPID --value`,
              { encoding: 'utf-8' },
            ).trim();
            const pid = Number(pidStr);
            if (Number.isInteger(pid) && pid > 0) {
              runningFromPath = resolveBinaryScript(pid);
            }
          } catch {
            // ignore
          }
        }
      } catch {
        try {
          const output = execSync(`${prefix} list-unit-files`, {
            encoding: 'utf-8',
          });
          if (output.includes(unit)) {
            kindStates[kind] = 'stopped';
            anyFound = true;
            allRunning = false;
          } else {
            kindStates[kind] = 'not_found';
            allRunning = false;
          }
        } catch {
          kindStates[kind] = 'not_found';
          allRunning = false;
        }
      }
    }
    service = !anyFound ? 'not_found' : allRunning ? 'running' : 'stopped';
  } else {
    // nohup PID files: gateway.pid / worker.pid
    let anyFound = false;
    let allRunning = true;
    for (const kind of kinds) {
      const pidFile = path.join(projectRoot, `${kind}.pid`);
      if (!fs.existsSync(pidFile)) {
        kindStates[kind] = 'not_found';
        allRunning = false;
        continue;
      }
      anyFound = true;
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          kindStates[kind] = 'running';
          if (!runningFromPath) runningFromPath = resolveBinaryScript(pid);
        } else {
          kindStates[kind] = 'stopped';
          allRunning = false;
        }
      } catch {
        kindStates[kind] = 'stopped';
        allRunning = false;
      }
    }
    service = !anyFound ? 'not_found' : allRunning ? 'running' : 'stopped';
  }

  if (
    service === 'running' &&
    runningFromPath &&
    !isPathInside(runningFromPath, projectRoot)
  ) {
    service = 'running_other_checkout';
  }

  log.info('Service status', { service, kindStates, runningFromPath });

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('docker info', { stdio: 'ignore' });
    containerRuntime = 'docker';
  } catch {
    // Docker not running
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
    'GITHUB_TOKEN',
    'LINEAR_API_KEY',
    'GCHAT_CREDENTIALS',
    'TEAMS_APP_ID',
    'TEAMS_APP_PASSWORD',
    'WEBEX_BOT_TOKEN',
    'MATRIX_ACCESS_TOKEN',
    'RESEND_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'IMESSAGE_ENABLED',
    'ZOHO_CLIQ_CLIENT_ID',
    'ZOHO_CLIQ_REFRESH_TOKEN',
  ]);

  const has = (key: string) => !!(process.env[key] || envVars[key]);
  const channelAuth: Record<string, string> = {};

  // WhatsApp Baileys: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels
  if (has('DISCORD_BOT_TOKEN')) channelAuth.discord = 'configured';
  if (has('TELEGRAM_BOT_TOKEN')) channelAuth.telegram = 'configured';
  if (has('SLACK_BOT_TOKEN') && has('SLACK_APP_TOKEN')) channelAuth.slack = 'configured';
  if (has('GITHUB_TOKEN')) channelAuth.github = 'configured';
  if (has('LINEAR_API_KEY')) channelAuth.linear = 'configured';
  if (has('GCHAT_CREDENTIALS')) channelAuth.gchat = 'configured';
  if (has('TEAMS_APP_ID') && has('TEAMS_APP_PASSWORD')) channelAuth.teams = 'configured';
  if (has('WEBEX_BOT_TOKEN')) channelAuth.webex = 'configured';
  if (has('MATRIX_ACCESS_TOKEN')) channelAuth.matrix = 'configured';
  if (has('RESEND_API_KEY')) channelAuth.resend = 'configured';
  if (has('WHATSAPP_ACCESS_TOKEN')) channelAuth['whatsapp-cloud'] = 'configured';
  if (has('IMESSAGE_ENABLED')) channelAuth.imessage = 'configured';
  if (has('ZOHO_CLIQ_CLIENT_ID') || has('ZOHO_CLIQ_REFRESH_TOKEN')) {
    channelAuth['zoho-cliq'] = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);

  // 5. Agent groups (classic host wiring) and/or gateway workspaces
  let registeredGroups = 0;
  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT ag.id) as count FROM agent_groups ag
           JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id`,
        )
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist (DB not migrated yet)
    }
  }

  let gatewayWorkspaces = 0;
  const gatewayDbPath = path.join(DATA_DIR, 'gateway.db');
  if (fs.existsSync(gatewayDbPath)) {
    try {
      const gdb = new Database(gatewayDbPath, { readonly: true });
      const row = gdb
        .prepare(`SELECT COUNT(*) as count FROM workspaces`)
        .get() as { count: number };
      gatewayWorkspaces = row.count;
      gdb.close();
    } catch {
      // schema may differ / empty
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  const status = determineVerifyStatus({
    service,
    credentials,
    registeredGroups,
    gatewayWorkspaces,
  });

  log.info('Verification complete', { status, channelAuth, kindStates });

  emitStatus('VERIFY', {
    SERVICE: service,
    ROLE: role,
    KINDS: kinds.join(','),
    KIND_STATES: JSON.stringify(kindStates),
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    GATEWAY_WORKSPACES: gatewayWorkspaces,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}

export function determineVerifyStatus(input: {
  service: 'not_found' | 'stopped' | 'running' | 'running_other_checkout';
  credentials: string;
  registeredGroups: number;
  gatewayWorkspaces?: number;
}): 'success' | 'failed' {
  const hasAgentSurface =
    input.registeredGroups > 0 || (input.gatewayWorkspaces ?? 0) > 0;
  return input.service === 'running' &&
    input.credentials !== 'missing' &&
    hasAgentSurface
    ? 'success'
    : 'failed';
}

/**
 * Given a PID, resolve the script path the process is executing (i.e. the
 * first `.js` / `.ts` / `.mjs` arg after `node`). Returns null on any
 * error — callers should treat null as "couldn't tell" and skip the
 * mismatch check rather than flag a false positive.
 */
function resolveBinaryScript(pid: number): string | null {
  try {
    // BSD ps (macOS) and util-linux both honour `-o command=` (full argv,
    // no header). Node argv: "node /path/to/dist/index.js ...".
    const out = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
    }).trim();
    const tokens = out.split(/\s+/);
    const script = tokens.find((t) => /\.(js|mjs|cjs|ts)$/.test(t));
    return script ?? null;
  } catch {
    return null;
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

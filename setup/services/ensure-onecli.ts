/**
 * Ensure local OneCLI is up before NanoClaw gateway/worker start.
 * If already healthy → no-op. If down and local → start the Community 2.x
 * Compose stack (web/api/gateway) + brief poll.
 * Remote ONECLI_URL → health check only (never start remotely).
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../../src/env.js';
import { readDotEnvKey } from '../lib/onecli-bootstrap.js';
import {
  childEnvWithLocalBin,
  composeNeedsRefresh,
  curlHealthOk,
  findComposeFile,
  listOnecliContainerIds,
  localComposePath,
  onecliHomeDir,
  startOnecliComposeStack,
  writeBundledCompose,
} from '../lib/onecli-local.js';

function childEnv(): NodeJS.ProcessEnv {
  return childEnvWithLocalBin();
}

function resolveOnecliUrl(_projectRoot: string): string | null {
  const fromEnv = process.env.ONECLI_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const fromFile = readEnvFile(['ONECLI_URL']).ONECLI_URL?.trim();
  return fromFile ? fromFile.replace(/\/$/, '') : null;
}

function isLocalOnecliUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function waitHealthy(url: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (curlHealthOk(url, childEnv())) return true;
    try {
      execSync('sleep 1', { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
  return false;
}

function startExistingOnecliContainers(): boolean {
  const list = listOnecliContainerIds(childEnv());
  if (!list.length) return false;
  console.log(`onecli: starting ${list.length} existing OneCLI container(s)`);
  try {
    execSync(`docker start ${list.map((id) => JSON.stringify(id)).join(' ')}`, {
      stdio: 'inherit',
      env: childEnv(),
    });
    return true;
  } catch (err) {
    console.warn(
      'onecli: docker start failed',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Recreate api/web/gateway when ~/.onecli compose is behind the NanoClaw bundle. */
function refreshLocalComposeIfStale(projectRoot: string): void {
  const file = findComposeFile();
  if (!file) return;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  if (!composeNeedsRefresh(existing)) return;
  const bundled = path.join(projectRoot, 'setup', 'resources', 'onecli-docker-compose.yml');
  if (!fs.existsSync(bundled)) return;
  writeBundledCompose(file);
  console.log('onecli: Compose was stale — recreating api/web/gateway');
  const result = startOnecliComposeStack(file, {
    log: (msg) => console.log(`onecli: ${msg}`),
  });
  if (!result.ok) {
    console.warn('onecli: compose refresh failed', result.stdout.slice(0, 1500));
  }
}

/** Current onecli-cli is a vault client — it does not start Compose. */
function startLocalGateway(projectRoot: string): boolean {
  const env = childEnv();
  try {
    execSync('onecli start', { cwd: projectRoot, stdio: 'ignore', env });
    return true;
  } catch {
    // expected on onecli-cli 1.3+: "unexpected argument start"
  }

  let file = findComposeFile();
  const bundled = path.join(projectRoot, 'setup', 'resources', 'onecli-docker-compose.yml');
  if (file) {
    try {
      const existing = fs.readFileSync(file, 'utf-8');
      if (fs.existsSync(bundled) && composeNeedsRefresh(existing)) {
        writeBundledCompose(file);
        console.log('onecli: refreshed Compose to Community 2.x multi-service stack');
      }
    } catch {
      // keep existing
    }
  } else if (fs.existsSync(bundled)) {
    const dest = localComposePath();
    if (writeBundledCompose(dest)) {
      file = dest;
      console.log(`onecli: wrote bundled Compose to ${dest}`);
    }
  }

  if (file) {
    console.log(`onecli: starting Community stack (${file})`);
    const result = startOnecliComposeStack(file, {
      log: (msg) => console.log(`onecli: ${msg}`),
    });
    if (!result.ok) {
      console.warn('onecli: compose start failed', result.stdout.slice(0, 1500));
      return false;
    }
    return true;
  }

  if (startExistingOnecliContainers()) return true;

  console.warn(
    'onecli: vault is down and no Compose file was found under ~/.onecli. ' +
      'Re-run NanoClaw setup and choose a fresh OneCLI install.',
  );
  return false;
}

/**
 * Call before starting gateway/worker. Never throws — logs and continues so
 * service start still proceeds if OneCLI is missing/misconfigured.
 */
export function ensureOnecliRunning(projectRoot: string): void {
  const url = resolveOnecliUrl(projectRoot);
  if (!url) {
    console.log('onecli: ONECLI_URL not set — skipping (set it in .env after setup)');
    return;
  }

  if (curlHealthOk(url, childEnv())) {
    console.log(`onecli: already running (${url})`);
    if (isLocalOnecliUrl(url)) {
      refreshLocalComposeIfStale(projectRoot);
      provisionApiKeyIfMissing(projectRoot);
    }
    return;
  }

  if (!isLocalOnecliUrl(url)) {
    console.warn(
      `onecli: not reachable at ${url} — start OneCLI on that host, then retry`,
    );
    return;
  }

  console.log(`onecli: not running — starting local gateway (${url})…`);
  if (!startLocalGateway(projectRoot)) {
    return;
  }

  if (waitHealthy(url, 90_000)) {
    console.log(`onecli: ready (${url})`);
  } else {
    console.warn(
      `onecli: started but health not OK within 90s — check:\n` +
        `  docker compose -p onecli -f ~/.onecli/docker-compose.yml ps\n` +
        `  curl -sf http://127.0.0.1:10254/v1/health\n` +
        `  curl -sf http://127.0.0.1:10256/v1/health`,
    );
    return;
  }

  provisionApiKeyIfMissing(projectRoot);
}

function provisionApiKeyIfMissing(projectRoot: string): void {
  const fromEnv = process.env.ONECLI_API_KEY?.trim();
  const fromFile = readEnvFile(['ONECLI_API_KEY']).ONECLI_API_KEY?.trim();
  const fromVault = readDotEnvKey(path.join(onecliHomeDir(), '.env'), 'ONECLI_API_KEY');
  if (fromEnv?.startsWith('oc_') || fromFile?.startsWith('oc_') || fromVault?.startsWith('oc_')) {
    return;
  }
  const setupEntry = path.join(projectRoot, 'setup', 'index.ts');
  if (!fs.existsSync(setupEntry)) return;
  console.log('onecli: no ONECLI_API_KEY yet — creating local vault auth key…');
  const tsxCli = ['cli.mjs', 'cli.js']
    .map((name) => path.join(projectRoot, 'node_modules', 'tsx', 'dist', name))
    .find((p) => fs.existsSync(p));
  try {
    if (tsxCli) {
      execFileSync(process.execPath, [tsxCli, setupEntry, '--step', 'onecli', '--bootstrap-auth'], {
        cwd: projectRoot,
        env: childEnv(),
        stdio: 'inherit',
        timeout: 90_000,
      });
    } else {
      execFileSync('pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', 'onecli', '--bootstrap-auth'], {
        cwd: projectRoot,
        env: childEnv(),
        stdio: 'inherit',
        timeout: 90_000,
      });
    }
  } catch {
    console.warn(
      'onecli: could not auto-create ONECLI_API_KEY. Re-run setup (`bash zclaw.sh`) so the vault key is written.',
    );
  }
}

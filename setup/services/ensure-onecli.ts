/**
 * Ensure local OneCLI is up before NanoClaw gateway/worker start.
 * If already healthy → no-op. If down and local → `onecli start` + brief poll.
 * Remote ONECLI_URL → health check only (never start remotely).
 */
import { execFileSync, execSync } from 'child_process';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../src/env.js';

function localBinPath(): string {
  return path.join(os.homedir(), '.local', 'bin');
}

function childEnv(): NodeJS.ProcessEnv {
  const local = localBinPath();
  const parts = [local];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
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

function healthOk(url: string): boolean {
  try {
    execFileSync(
      'curl',
      ['-fsS', '--max-time', '2', `${url}/api/health`],
      { stdio: 'ignore', env: childEnv() },
    );
    return true;
  } catch {
    // Older OneCLI docs used /health — try both.
    try {
      execFileSync('curl', ['-fsS', '--max-time', '2', `${url}/health`], {
        stdio: 'ignore',
        env: childEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

function waitHealthy(url: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (healthOk(url)) return true;
    try {
      execSync('sleep 1', { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
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

  if (healthOk(url)) {
    console.log(`onecli: already running (${url})`);
    return;
  }

  if (!isLocalOnecliUrl(url)) {
    console.warn(
      `onecli: not reachable at ${url} — start OneCLI on that host, then retry`,
    );
    return;
  }

  console.log(`onecli: not running — starting local gateway (${url})…`);
  try {
    execSync('onecli start', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: childEnv(),
    });
  } catch (err) {
    console.warn(
      'onecli: `onecli start` failed — continuing with gateway/worker anyway',
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (waitHealthy(url, 30_000)) {
    console.log(`onecli: ready (${url})`);
  } else {
    console.warn(
      `onecli: started but /api/health not OK within 30s — check: curl -sf ${url}/api/health`,
    );
  }
}

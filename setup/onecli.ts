/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Two modes:
 *   (default) run the local Compose vault + CLI install, write .env.
 *   --reuse   skip wipe; reuse/start the existing ~/.onecli stack.
 *   --fresh   wipe ~/.onecli + containers/volumes, then install clean.
 *   --remote-url <url>  CLI only, point at a remote vault.
 *   --bootstrap-auth    stack already up; mint/write ONECLI_API_KEY only.
 *
 * Emits ONECLI_URL, ONECLI_API_KEY, and polls /v1/health.
 */
import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { ensureLocalOnecliApiKey } from './lib/onecli-bootstrap.js';
import {
  LOCAL_API_URL,
  LOCAL_GATEWAY_URL,
  ONECLI_GATEWAY_VERSION,
  bundledComposePath,
  childEnvWithLocalBin,
  composeNeedsRefresh,
  listOnecliContainerIds,
  localComposePath,
  localStackPresent,
  onecliHealthUrls,
  onecliHomeDir,
  startOnecliComposeStack,
  writeBundledCompose,
} from './lib/onecli-local.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail.
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

/** User-visible progress for the setup windowed runner + raw step log. */
function progress(msg: string): void {
  console.log(msg);
  log.info(msg);
}

function childEnv(): NodeJS.ProcessEnv {
  return childEnvWithLocalBin();
}

/** Prefer an absolute path so PATH quirks cannot hide a successful install. */
function resolveOnecliBin(): string | null {
  const candidates = [
    path.join(LOCAL_BIN, 'onecli'),
    '/usr/local/bin/onecli',
    '/usr/bin/onecli',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // keep looking
    }
  }
  try {
    const which = execFileSync('which', ['onecli'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {
    // not on PATH
  }
  return null;
}

function onecliBin(): string {
  return resolveOnecliBin() ?? 'onecli';
}

function onecliVersion(): string | null {
  const bin = resolveOnecliBin();
  if (!bin) return null;
  try {
    return execFileSync(bin, ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Keep this Node process and child shells seeing ~/.local/bin. */
function ensureLocalBinOnPath(): void {
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  process.env.PATH = childEnv().PATH;
}

/**
 * Ask the installed onecli CLI for its configured api-host. Returns null if
 * onecli isn't on PATH, errors, or has no api-host configured.
 *
 * Tolerates both JSON output (onecli 1.3+) and older raw-text output.
 */
export function getOnecliApiHost(): string | null {
  try {
    const out = execFileSync(onecliBin(), ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      const parsed = JSON.parse(out) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // not JSON — fall through to URL extraction
    }
    return extractUrlFromOutput(out);
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const matches = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/g) ?? [];
  const urls = matches.filter((u) => !isInstallerNoiseUrl(u));
  const local = urls.find((u) => isLocalGatewayHost(u));
  return local ?? urls[0] ?? null;
}

function isInstallerNoiseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com') ||
      host === 'ghcr.io' ||
      host.endsWith('.ghcr.io')
    );
  } catch {
    return true;
  }
}

function isLocalGatewayHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1';
  } catch {
    return false;
  }
}

function isUsableLocalApiHost(url: string | null | undefined): url is string {
  if (!url?.trim()) return false;
  if (isInstallerNoiseUrl(url)) return false;
  return isLocalGatewayHost(url);
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvVar(name: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${name}=${value}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `${name}=${value}\n`;
  }
  fs.writeFileSync(envFile, content);
}

function writeEnvOnecliUrl(url: string): void {
  try {
    const u = new URL(url);
    const local =
      u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    if (local && (u.port === '10254' || u.port === '')) {
      u.port = '10256';
      url = u.origin;
    }
  } catch {
    // keep as-is
  }
  writeEnvVar('ONECLI_URL', url);
}

/** CLI and/or ~/.onecli stack we can reuse (ignore a bogus GitHub api-host). */
export function detectReusableLocalOnecli(): { version: string; apiHost: string } | null {
  const version = onecliVersion();
  const host = getOnecliApiHost();
  const stack = localStackPresent(childEnv());
  if (!version && !stack) return null;
  if (!stack && !isUsableLocalApiHost(host)) return null;
  return {
    version: version ?? 'installed',
    apiHost: isUsableLocalApiHost(host) ? host : LOCAL_API_URL,
  };
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

function ensureEnvKey(content: string, key: string, value: string): string {
  if (new RegExp(`^${key}=`, 'm').test(content)) return content;
  return content + (content && !content.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
}

function stripEnvKey(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}=.*\\r?\\n?`, 'gm'), '');
}

function setEnvKey(content: string, key: string, value: string): string {
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }
  return ensureEnvKey(content, key, value);
}

function writeOnecliEnv(envFile: string): void {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  // Local vault Postgres uses trust auth — never set/use a DB password.
  content = stripEnvKey(content, 'POSTGRES_PASSWORD');
  content = ensureEnvKey(content, 'ONECLI_BIND_HOST', '127.0.0.1');
  // Always pin the image tag we ship (do not leave a stale 1.x value).
  content = setEnvKey(content, 'ONECLI_VERSION', ONECLI_GATEWAY_VERSION);
  content = ensureEnvKey(content, 'POSTGRES_USER', 'onecli');
  content = ensureEnvKey(content, 'POSTGRES_DB', 'onecli');
  content = setEnvKey(content, 'ONECLI_EXTERNAL_URL', LOCAL_GATEWAY_URL);
  content = setEnvKey(content, 'APP_URL', LOCAL_GATEWAY_URL);
  content = setEnvKey(content, 'API_URL', 'http://127.0.0.1:10256');
  content = setEnvKey(content, 'GATEWAY_API_URL', 'http://127.0.0.1:10255');
  content = setEnvKey(content, 'ONECLI_AGENT_PROXY_ADDRESS', 'host.docker.internal:10255');
  for (const key of [
    'NEXTAUTH_SECRET',
    'SECRET_ENCRYPTION_KEY',
    'GATEWAY_INTERNAL_SECRET',
    'BETTER_AUTH_SECRET',
  ]) {
    content = ensureEnvKey(content, key, randomSecret());
  }
  fs.writeFileSync(envFile, content, { mode: 0o600 });
}

/** Tear down containers/volumes/dir so a fresh install is not mixed with old Postgres data. */
function wipeLocalOnecli(): void {
  const dir = onecliHomeDir();
  const dest = localComposePath();
  const env = childEnv();
  progress('Wiping previous local OneCLI (containers, volumes, ~/.onecli)…');
  if (fs.existsSync(dest)) {
    try {
      execSync(`docker compose -p onecli -f ${JSON.stringify(dest)} down -v --remove-orphans`, {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // continue with force-rm
    }
  }
  try {
    const ids = listOnecliContainerIds(env);
    if (ids.length) {
      execSync(`docker rm -f ${ids.join(' ')}`, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch {
    // ignore
  }
  try {
    const vols = execSync('docker volume ls -q', {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\n/)
      .map((v) => v.trim())
      .filter((v) => /onecli/i.test(v));
    if (vols.length) {
      execSync(`docker volume rm ${vols.join(' ')}`, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch {
    // ignore
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Could not remove ~/.onecli', { err });
  }
}

/** Write bundled compose + secrets and start the stack. No onecli.sh/install. */
function ensureLocalOnecliStack(opts: { forceCompose?: boolean } = {}): { ok: boolean; stdout: string } {
  const home = onecliHomeDir();
  const dest = localComposePath();
  const envFile = path.join(home, '.env');
  fs.mkdirSync(home, { recursive: true });
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : '';
  const needsWrite = opts.forceCompose || composeNeedsRefresh(existing);
  if (needsWrite) {
    if (!writeBundledCompose(dest)) {
      return { ok: false, stdout: `Bundled compose missing: ${bundledComposePath()}` };
    }
    progress(`Wrote ${dest}`);
  }
  writeOnecliEnv(envFile);
  const result = startOnecliComposeStack(dest, { log: progress });
  if (!result.ok) {
    log.error('OneCLI compose stack failed', { detail: result.stdout });
  }
  return result;
}

function installOnecliCliOnly(): { stdout: string; ok: boolean } {
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  if (upstream.ok && resolveOnecliBin()) return { stdout: upstream.stdout, ok: true };
  const fallback = installOnecliCliDirect();
  return {
    stdout: upstream.stdout + (upstream.stderr ?? '') + '\n' + fallback.stdout,
    ok: fallback.ok && !!resolveOnecliBin(),
  };
}

/**
 * Local vault install: NanoClaw-owned Compose under ~/.onecli (no onecli.sh/install).
 * That upstream script often fails on Podman (bind host / Compose Spec).
 */
function installOnecli(opts: { fresh?: boolean } = {}): { stdout: string; ok: boolean } {
  let stdout = '';

  if (opts.fresh) {
    wipeLocalOnecli();
  }

  const alreadyCli = !!resolveOnecliBin();
  progress('Installing local OneCLI vault via bundled Compose…');
  const stack = ensureLocalOnecliStack({ forceCompose: !!opts.fresh });
  stdout += stack.stdout ? `\n${stack.stdout}` : '';
  if (!stack.ok) {
    log.error('OneCLI compose stack failed', { stderr: stack.stdout });
    return { stdout, ok: false };
  }

  if (alreadyCli && !opts.fresh) {
    progress(`onecli CLI already present (${resolveOnecliBin()}) — skipping CLI reinstall`);
    return { stdout, ok: true };
  }

  progress('Installing onecli CLI…');
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  stdout += upstream.stdout;
  if (upstream.stdout.trim()) console.log(upstream.stdout.trim());
  if (upstream.ok && resolveOnecliBin()) {
    progress(`CLI ready at ${resolveOnecliBin()}`);
    return { stdout, ok: true };
  }

  progress('Upstream CLI installer failed — downloading release archive…');
  log.warn('Upstream CLI installer failed or left no binary — falling back to direct download', {
    stderr: upstream.stderr,
    upstreamOk: upstream.ok,
    bin: resolveOnecliBin(),
  });
  stdout += (upstream.stderr ?? '') + '\n';

  const fallback = installOnecliCliDirect();
  stdout += fallback.stdout;
  if (fallback.stdout.trim()) console.log(fallback.stdout.trim());
  if (!fallback.ok || !resolveOnecliBin()) {
    log.error('OneCLI CLI install failed (both upstream and direct fallback)');
    return { stdout, ok: false };
  }
  progress(`CLI ready at ${resolveOnecliBin()}`);
  return { stdout, ok: true };
}

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr, ok: false };
  }
}

/**
 * Install CLI without the rate-limited releases API: follow /releases/latest
 * redirect, download the archive, install to ~/.local/bin or /usr/local/bin.
 */
function installOnecliCliDirect(): { stdout: string; ok: boolean } {
  const lines: string[] = [];
  const append = (s: string): void => {
    lines.push(s);
  };

  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!osName) {
    append(`Unsupported platform: ${process.platform}`);
    return { stdout: lines.join('\n'), ok: false };
  }
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    append(`Unsupported arch: ${process.arch}`);
    return { stdout: lines.join('\n'), ok: false };
  }

  let version: string | null = null;
  try {
    const redirect = execSync(
      `curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/${ONECLI_CLI_REPO}/releases/latest`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const m = redirect.match(/\/tag\/v?([^/]+)$/);
    if (m) version = m[1];
  } catch {
    // redirect probe failed — pin fallback
  }
  if (!version) {
    version = ONECLI_CLI_FALLBACK_VERSION;
    append(`Version probe failed; installing pinned fallback ${version}.`);
  } else {
    append(`Resolved onecli CLI ${version} via release redirect.`);
  }

  const archive = `onecli_${version}_${osName}_${arch}.tar.gz`;
  const url = `https://github.com/${ONECLI_CLI_REPO}/releases/download/v${version}/${archive}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-'));
  const archivePath = path.join(tmpDir, archive);

  try {
    append(`Downloading ${url}`);
    execSync(`curl -fsSL -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(tmpDir)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let installDir = '/usr/local/bin';
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      installDir = LOCAL_BIN;
      fs.mkdirSync(installDir, { recursive: true });
    }
    const binSrc = path.join(tmpDir, 'onecli');
    if (!fs.existsSync(binSrc)) {
      append(`Archive extracted but ${binSrc} missing`);
      return { stdout: lines.join('\n'), ok: false };
    }
    const binDest = path.join(installDir, 'onecli');
    fs.copyFileSync(binSrc, binDest);
    fs.chmodSync(binDest, 0o755);
    append(`onecli ${version} installed to ${binDest}.`);
    return { stdout: lines.join('\n'), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    append(`Direct install failed: ${e.stderr ?? e.message ?? String(err)}`);
    return { stdout: lines.join('\n'), ok: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** True when the CLI can reach its configured server (works even if /api/health is auth-gated). */
function cliServerOk(): boolean {
  const raw = onecliVersion();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { server_status?: string };
    return parsed.server_status === 'ok';
  } catch {
    return /"server_status"\s*:\s*"ok"/i.test(raw);
  }
}

/**
 * Poll vault readiness. Each attempt is hard-capped (AbortSignal) so a
 * half-open TCP port cannot stall setup forever — that was hanging zclaw
 * on "Checking health…".
 */
export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probes = onecliHealthUrls(url);
  let lastLog = 0;
  while (Date.now() < deadline) {
    if (cliServerOk()) return true;
    for (const probe of probes) {
      try {
        const res = await fetch(probe, { signal: AbortSignal.timeout(2500) });
        if (res.ok) return true;
        // Listening but not ready yet (or auth-gated) — count as up only for 2xx.
      } catch {
        // connection refused / timeout
      }
    }
    const now = Date.now();
    if (now - lastLog >= 10_000) {
      const left = Math.max(0, Math.ceil((deadline - now) / 1000));
      progress(`Still waiting for OneCLI health (${left}s left)…`);
      lastLog = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return cliServerOk();
}

function setApiHost(bin: string, url: string): void {
  try {
    execFileSync(bin, ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
    progress(`Set onecli api-host to ${url}`);
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }
}

function loginCliWithApiKey(apiKey: string): void {
  const bin = resolveOnecliBin();
  if (!bin) return;
  try {
    execFileSync(bin, ['auth', 'login', '--api-key', apiKey], {
      stdio: 'ignore',
      env: childEnv(),
    });
    progress('Logged onecli CLI into the local vault');
  } catch (err) {
    log.warn('onecli auth login failed', { err });
  }
}

/** Create/reuse the local oc_ key so /build and secrets work without the dashboard. */
async function provisionLocalApiKey(): Promise<boolean> {
  progress('Provisioning local OneCLI API key…');
  try {
    const result = await ensureLocalOnecliApiKey();
    if (!result.ok || !result.apiKey) {
      progress(`Could not provision OneCLI API key (${result.error ?? 'unknown'})`);
      log.warn('Local OneCLI API key bootstrap failed', { error: result.error });
      return false;
    }
    loginCliWithApiKey(result.apiKey);
    progress(
      result.reusedKey
        ? 'Reused existing OneCLI API key'
        : 'Wrote ONECLI_API_KEY to .env (host-to-vault auth; not your Anthropic key)',
    );
    return true;
  } catch (err) {
    log.warn('Local OneCLI API key bootstrap threw', { err });
    progress('Could not provision OneCLI API key');
    return false;
  }
}

export async function run(args: string[]): Promise<void> {
  const reuse = args.includes('--reuse');
  const fresh = args.includes('--fresh');
  const bootstrapOnly = args.includes('--bootstrap-auth');
  const remoteUrlIdx = args.indexOf('--remote-url');
  const remoteUrl = remoteUrlIdx !== -1 ? args[remoteUrlIdx + 1] : null;
  ensureLocalBinOnPath();
  ensureShellProfilePath();

  if (bootstrapOnly) {
    const url = LOCAL_API_URL;
    writeEnvOnecliUrl(url);
    const bin = resolveOnecliBin();
    if (bin) setApiHost(bin, url);
    const healthy = await pollHealth(url, 60_000);
    const keyed = healthy ? await provisionLocalApiKey() : false;
    emitStatus('ONECLI', {
      INSTALLED: true,
      BOOTSTRAP_ONLY: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      API_KEY: keyed,
      STATUS: keyed ? 'success' : 'failed',
      ...(keyed ? {} : { ERROR: 'api_key_bootstrap_failed' }),
      LOG: 'logs/setup.log',
    });
    if (!keyed) process.exit(1);
    return;
  }

  if (remoteUrl) {
    log.info('Installing OneCLI CLI for remote gateway', { remoteUrl });
    const res = installOnecliCliOnly();
    if (!res.ok || !onecliVersion()) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'cli_install_failed',
        HINT: 'CLI binary install failed. Make sure curl is installed and ~/.local/bin is writable.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    setApiHost(onecliBin(), remoteUrl);
    writeEnvOnecliUrl(remoteUrl);
    log.info('Wrote ONECLI_URL to .env', { url: remoteUrl });
    const remoteToken = process.env.NANOCLAW_ONECLI_API_TOKEN?.trim();
    if (remoteToken) {
      try {
        execFileSync(onecliBin(), ['auth', 'login', '--api-key', remoteToken], {
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (err) {
        log.warn('onecli auth login failed', { err });
      }
      writeEnvVar('ONECLI_API_KEY', remoteToken);
      log.info('Wrote ONECLI_API_KEY to .env');
    }
    const healthy = await pollHealth(remoteUrl, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REMOTE: true,
      ONECLI_URL: remoteUrl,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (reuse) {
    const url = detectReusableLocalOnecli()?.apiHost ?? LOCAL_API_URL;
    progress(`Reusing local OneCLI vault at ${url}`);
    const stack = ensureLocalOnecliStack();
    if (!stack.ok && !localStackPresent(childEnv())) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'compose_start_failed',
        HINT: stack.stdout.slice(0, 2000),
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    const bin = resolveOnecliBin();
    if (bin) setApiHost(bin, url);
    writeEnvOnecliUrl(url);
    progress(`Checking OneCLI health at ${url}…`);
    const healthy = await pollHealth(url, 60_000);
    progress(healthy ? 'OneCLI health OK' : 'OneCLI health not ready yet (continuing)');
    const keyed = healthy ? await provisionLocalApiKey() : false;
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      API_KEY: keyed,
      STATUS: keyed || healthy ? 'success' : 'failed',
      LOG: 'logs/setup.log',
    });
    return;
  }

  progress(fresh ? 'Fresh OneCLI install…' : 'Installing OneCLI gateway and CLI…');
  const res = installOnecli({ fresh });
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      HINT: res.stdout.slice(0, 2000),
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  const bin = resolveOnecliBin();
  if (!bin || !onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: `CLI binary missing after install (looked in ${LOCAL_BIN} and /usr/local/bin). Re-run bash zclaw.sh.`,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  progress(`OneCLI CLI ready: ${bin}`);

  const url = LOCAL_API_URL;
  setApiHost(bin, url);
  writeEnvOnecliUrl(url);
  progress(`Wrote ONECLI_URL=${url} to .env (API; dashboard is ${LOCAL_GATEWAY_URL})`);

  progress(`Checking OneCLI health at ${url}…`);
  const healthy = cliServerOk() || (await pollHealth(url, 60_000));
  progress(healthy ? 'OneCLI health OK' : 'OneCLI health not ready yet (continuing)');
  const keyed = healthy ? await provisionLocalApiKey() : false;

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    API_KEY: keyed,
    STATUS: keyed ? 'success' : healthy ? 'success' : 'failed',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll timed out. Check: docker compose -p onecli -f ~/.onecli/docker-compose.yml ps && curl -sf http://127.0.0.1:10256/v1/health',
        }),
    LOG: 'logs/setup.log',
  });
}

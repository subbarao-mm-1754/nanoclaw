/**
 * Shared helpers for the local OneCLI Compose vault (~/.onecli).
 * Used by setup/onecli.ts and setup/services/ensure-onecli.ts.
 *
 * OneCLI Community 2.x is multi-service (web/api/gateway/migrations/postgres),
 * not the old single ghcr.io/onecli/onecli image.
 *
 * Podman's docker shim rejects `--filter label=…` ("label is an invalid filter").
 * Always prefer `docker compose -p onecli …` and `--filter name=…`.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Dashboard (web UI). */
export const LOCAL_GATEWAY_URL = 'http://127.0.0.1:10254';
/** Community 2.x REST API — NanoClaw SDK/CLI must use this, not the dashboard. */
export const LOCAL_API_URL = 'http://127.0.0.1:10256';
/**
 * Community image tag pin (web/api/gateway/migrations share this).
 * GHCR tags are semver WITHOUT a leading `v` (e.g. 2.7.0, not v2.7.0).
 */
export const ONECLI_GATEWAY_VERSION = '2.7.0';

export function onecliHomeDir(): string {
  return path.join(os.homedir(), '.onecli');
}

export function localComposePath(): string {
  return path.join(onecliHomeDir(), 'docker-compose.yml');
}

/** Bundled Compose file next to this module (setup/resources/…). */
export function bundledComposePath(): string {
  return path.join(HERE, '..', 'resources', 'onecli-docker-compose.yml');
}

export function childEnvWithLocalBin(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const parts = [localBin];
  if (base.PATH) parts.push(base.PATH);
  return { ...base, PATH: parts.join(path.delimiter) };
}

/**
 * List containers belonging to the local OneCLI stack.
 * Never uses label filters (unsupported by Podman docker shim).
 */
export function listOnecliContainerIds(env: NodeJS.ProcessEnv = childEnvWithLocalBin()): string[] {
  const ids = new Set<string>();

  for (const args of ['ps -aq', 'ps -q']) {
    try {
      const out = execSync(`docker compose -p onecli ${args}`, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      for (const id of out.split(/\s+/).filter(Boolean)) ids.add(id);
      if (ids.size) return [...ids];
    } catch {
      // try next
    }
  }

  for (const name of [
    'onecli-web',
    'onecli-api',
    'onecli-gateway',
    'onecli-migrations',
    'onecli-postgres',
    'onecli_postgres',
    'onecli',
  ]) {
    try {
      const out = execSync(`docker ps -aq --filter name=${name}`, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      for (const id of out.split(/\s+/).filter(Boolean)) ids.add(id);
    } catch {
      // ignore
    }
  }
  return [...ids];
}

/** True when ~/.onecli compose exists or OneCLI containers are present. */
export function localStackPresent(env: NodeJS.ProcessEnv = childEnvWithLocalBin()): boolean {
  if (fs.existsSync(localComposePath())) return true;
  return listOnecliContainerIds(env).length > 0;
}

/** Podman often ships Compose 1.x, which rejects Compose Spec `name:`. */
export function dockerComposeIsLegacyV1(env: NodeJS.ProcessEnv = childEnvWithLocalBin()): boolean {
  for (const cmd of ['docker compose version', 'docker-compose version']) {
    try {
      const out = execSync(cmd, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (/version\s+1\./i.test(out)) return true;
      if (/version\s+v?2\./i.test(out)) return false;
    } catch {
      // try next
    }
  }
  return true;
}

/** Whether an on-disk compose file should be replaced with the NanoClaw bundle. */
export function composeNeedsRefresh(existing: string): boolean {
  if (!existing.trim()) return true;
  // Old single-image stack (pre–Community 2.x multi-service)
  if (!/onecli-web/.test(existing) || !/onecli-api/.test(existing)) return true;
  if (/^name:\s/m.test(existing) && !/^version:\s/m.test(existing)) return true;
  if (dockerComposeIsLegacyV1() && /^name:\s/m.test(existing)) return true;
  if (/POSTGRES_PASSWORD/i.test(existing)) return true;
  if (!/POSTGRES_HOST_AUTH_METHOD/i.test(existing)) return true;
  if (/DATABASE_URL:\s*postgresql:\/\/[^:/@]+:[^@/]+@/i.test(existing)) return true;
  // Old pin sent BYO containers at Compose DNS `gateway`, which they cannot resolve.
  if (/ONECLI_AGENT_PROXY_ADDRESS:\s*gateway:10255/.test(existing)) return true;
  if (!/host\.docker\.internal:10255/.test(existing)) return true;
  // Hosted-runner network — Podman compose 1.x often fails to attach gateway to it.
  if (/^\s+sandboxes:/m.test(existing) || /internal:\s*true/.test(existing)) return true;
  if (!/user:\s*"0"/.test(existing) || !/gateway-data:/.test(existing)) return true;
  return false;
}

export function writeBundledCompose(dest: string): boolean {
  const bundled = bundledComposePath();
  if (!fs.existsSync(bundled)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(bundled, dest);
  return true;
}

export function findComposeFile(): string | null {
  const roots = [onecliHomeDir(), path.join(os.homedir(), 'onecli')];
  const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const root of roots) {
    for (const name of names) {
      const direct = path.join(root, name);
      if (fs.existsSync(direct)) return direct;
      const nested = path.join(root, 'docker', name);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

/** HTTP health probes that work for OneCLI 2.x (+ older paths). */
export function onecliHealthUrls(baseUrl: string): string[] {
  const root = baseUrl.replace(/\/$/, '');
  const urls = [`${root}/v1/health`, `${root}/api/health`, `${root}/health`];
  // Community 2.x also publishes the API on 10256.
  try {
    const u = new URL(root);
    if (u.port === '10254' || !u.port) {
      u.port = '10256';
      urls.push(`${u.origin}/v1/health`, `${u.origin}/health`);
    }
  } catch {
    // ignore
  }
  return urls;
}

export function curlHealthOk(url: string, env: NodeJS.ProcessEnv = childEnvWithLocalBin()): boolean {
  for (const probe of onecliHealthUrls(url)) {
    try {
      execFileSync('curl', ['-fsS', '--max-time', '2', probe], {
        stdio: 'ignore',
        env,
      });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

function composeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...childEnvWithLocalBin(),
    ONECLI_BIND_HOST: '127.0.0.1',
    ONECLI_VERSION: ONECLI_GATEWAY_VERSION,
    ...extra,
  };
}

function runCompose(
  file: string,
  args: string,
  env: NodeJS.ProcessEnv,
): { ok: boolean; out: string } {
  const cwd = path.dirname(file);
  try {
    const out = execSync(`docker compose -p onecli -f ${JSON.stringify(file)} ${args}`, {
      encoding: 'utf-8',
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out ?? '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`.trim(),
    };
  }
}

function sleep(ms: number): void {
  try {
    execSync(`sleep ${Math.max(1, Math.ceil(ms / 1000))}`, { stdio: 'ignore' });
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function waitPostgres(file: string, env: NodeJS.ProcessEnv, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = runCompose(
      file,
      'exec -T postgres pg_isready -U onecli',
      env,
    );
    if (r.ok) return true;
    sleep(2000);
  }
  return false;
}

/**
 * Bring up the Community 2.x stack in stages that work on Compose 1.x:
 * postgres → migrations → api/web/gateway.
 */
export function startOnecliComposeStack(
  file: string,
  opts: { log?: (msg: string) => void } = {},
): { ok: boolean; stdout: string } {
  const log = opts.log ?? (() => undefined);
  const env = composeEnv();
  const lines: string[] = [];
  const note = (s: string): void => {
    lines.push(s);
    log(s);
  };

  note(`Starting OneCLI postgres (${file})…`);
  let r = runCompose(file, 'up -d postgres', env);
  lines.push(r.out);
  if (!r.ok) return { ok: false, stdout: lines.join('\n') };

  note('Waiting for Postgres…');
  if (!waitPostgres(file, env, 60_000)) {
    return { ok: false, stdout: lines.join('\n') + '\nPostgres did not become ready' };
  }

  note('Running OneCLI migrations…');
  r = runCompose(file, 'run --rm migrations', env);
  lines.push(r.out);
  if (!r.ok) {
    // Image pull failures must not be ignored; only tolerate already-applied schema.
    if (/manifest unknown|not found|pull access denied|denied/i.test(r.out)) {
      return { ok: false, stdout: lines.join('\n') };
    }
    note('Migrations reported an error — continuing (schema may already exist)');
  }

  note('Starting OneCLI api and web…');
  r = runCompose(file, 'up -d api web', env);
  lines.push(r.out);
  if (!r.ok) return { ok: false, stdout: lines.join('\n') };

  note('Preparing OneCLI gateway data volume…');
  r = runCompose(file, 'run --rm --no-deps gateway-data', env);
  lines.push(r.out);
  if (!r.ok) {
    note('gateway-data chmod failed — continuing (gateway user 0 may still write)');
  }

  if (gatewayHealthOk(env)) {
    note('OneCLI credential gateway already healthy on 10255.');
    note('OneCLI Compose stack started.');
    return { ok: true, stdout: lines.join('\n') };
  }

  note('Freeing stale listeners on 127.0.0.1:10255 (Podman rootlessport leftovers)…');
  lines.push(freeStaleGatewayPort(env, note));

  note('Starting OneCLI credential gateway…');
  r = runCompose(file, 'up -d gateway', env);
  lines.push(r.out);
  if (!r.ok && /address already in use/i.test(r.out)) {
    note('Port 10255 still busy — removing leftover gateway containers and retrying…');
    lines.push(freeStaleGatewayPort(env, note));
    r = runCompose(file, 'up -d gateway', env);
    lines.push(r.out);
  }
  if (!r.ok) {
    lines.push(gatewayDebug(file, env));
    lines.push(describeGatewayPortHolders(env));
    return { ok: false, stdout: lines.join('\n') };
  }

  try {
    runCompose(file, 'start gateway', env);
  } catch {
    // ignore
  }

  note('Waiting for OneCLI credential gateway (http://127.0.0.1:10255/healthz)…');
  if (!waitGatewayPort(env, 60_000)) {
    lines.push(gatewayDebug(file, env));
    lines.push(describeGatewayPortHolders(env));
    return {
      ok: false,
      stdout:
        lines.join('\n') +
        '\nOneCLI gateway did not become healthy on port 10255. /build cannot inject vault credentials until this is running.',
    };
  }

  note('OneCLI Compose stack started.');
  return { ok: true, stdout: lines.join('\n') };
}

function gatewayHealthOk(env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('curl', ['-fsS', '--max-time', '2', 'http://127.0.0.1:10255/healthz'], {
      stdio: 'ignore',
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove exited/created gateway containers that still hold 10255 via rootlessport. */
function freeStaleGatewayPort(
  env: NodeJS.ProcessEnv,
  note: (s: string) => void,
): string {
  const lines: string[] = [];
  const ids = new Set<string>();

  for (const name of ['onecli-gateway', 'onecli_gateway_1', 'onecli-onecli-gateway-1']) {
    try {
      const out = execSync(`docker ps -aq --filter name=${name}`, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      for (const id of out.split(/\s+/).filter(Boolean)) ids.add(id);
    } catch {
      // ignore
    }
  }

  try {
    const out = execSync('docker ps -a --format "{{.ID}} {{.Ports}} {{.Names}} {{.Status}}"', {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      if (!/10255/.test(line)) continue;
      const id = line.trim().split(/\s+/)[0];
      if (id) ids.add(id);
    }
  } catch {
    // ignore
  }

  if (!ids.size) {
    lines.push('No leftover containers found publishing 10255.');
    return lines.join('\n');
  }

  note(`Removing ${ids.size} leftover container(s) holding 10255…`);
  try {
    execSync(`docker rm -f ${[...ids].join(' ')}`, {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lines.push(`Removed: ${[...ids].join(' ')}`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    lines.push(`docker rm -f failed: ${e.stderr ?? e.message ?? String(err)}`);
  }
  sleep(1000);
  return lines.join('\n');
}

function describeGatewayPortHolders(env: NodeJS.ProcessEnv): string {
  const chunks = ['--- process/container holding 10255 ---'];
  for (const cmd of [
    'ss -ltnp sport = :10255',
    'lsof -nP -iTCP:10255 -sTCP:LISTEN',
  ]) {
    try {
      chunks.push(
        execSync(cmd, {
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || `(${cmd}: empty)`,
      );
    } catch {
      // command missing
    }
  }
  return chunks.join('\n');
}

function gatewayDebug(file: string, env: NodeJS.ProcessEnv): string {
  const chunks: string[] = ['--- onecli-gateway debug ---'];
  for (const args of [
    'ps -a',
    'logs --tail=80 gateway',
  ]) {
    const r = runCompose(file, args, env);
    chunks.push(r.out || `(compose ${args} failed)`);
  }
  try {
    chunks.push(
      execSync('docker ps -a --filter name=onecli-gateway --format "{{.ID}} {{.Status}} {{.Names}}"', {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    // ignore
  }
  try {
    chunks.push(
      execSync('docker logs --tail 80 onecli-gateway', {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    chunks.push(e.stderr ?? e.message ?? String(err));
  }
  return chunks.join('\n');
}

/** True when the MITM gateway answers /healthz (CA exists after it listens). */
function waitGatewayPort(env: NodeJS.ProcessEnv, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gatewayHealthOk(env)) return true;
    sleep(2000);
  }
  return false;
}

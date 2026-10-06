/**
 * OneCLI Community 2.x client (GET/POST /v1/…).
 *
 * NanoClaw still depends on @onecli-sh/sdk 0.5.0, which calls the retired
 * /api/agents and /api/container-config paths on the dashboard port.
 * Community 2.x serves those on the API (10256) under /v1.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';

export class OnecliV1Error extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'OnecliV1Error';
  }
}

interface ContainerConfigV1 {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

const SYSTEM_CA_PATHS = [
  '/etc/ssl/cert.pem',
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
];

/** Dashboard 10254 → API 10256. Leave cloud / custom URLs alone. */
export function onecliApiBase(url = ONECLI_URL): string {
  const raw = (url ?? '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://127.0.0.1:10256';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const local =
      host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
    if (local && (u.port === '10254' || u.port === '')) {
      u.port = '10256';
    }
    return u.origin;
  } catch {
    return raw;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ONECLI_API_KEY) headers.Authorization = `Bearer ${ONECLI_API_KEY}`;
  return headers;
}

/** Compose DNS `gateway` is not visible to NanoClaw agent containers on the host runtime. */
function rewriteLocalProxyEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(/@gateway:10255\b/g, '@host.docker.internal:10255');
  }
  return out;
}

async function v1Fetch(method: string, pathname: string, body?: unknown): Promise<Response> {
  const url = `${onecliApiBase()}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

export async function ensureAgentV1(input: { name: string; identifier: string }): Promise<void> {
  if (!ONECLI_API_KEY) {
    throw new OnecliV1Error(
      'ONECLI_API_KEY is not set. Re-run NanoClaw setup so it can write the local vault key, then restart gateway and worker.',
    );
  }
  const res = await v1Fetch('POST', '/v1/agents', {
    name: input.name,
    identifier: input.identifier,
  });
  if (res.ok || res.status === 409) return;
  const text = await res.text().catch(() => '');
  throw new OnecliV1Error(
    `OneCLI ensureAgent failed (${res.status}) ${text.slice(0, 400)}`,
    res.status,
    `${onecliApiBase()}/v1/agents`,
  );
}

function writeCaCertificate(caCertificate: string): string {
  const outPath = path.join(os.tmpdir(), 'onecli-proxy-ca.pem');
  fs.writeFileSync(outPath, caCertificate);
  return outPath;
}

function buildCombinedCaBundle(caCertificate: string): string | null {
  for (const sysPath of SYSTEM_CA_PATHS) {
    try {
      const sysCa = fs.readFileSync(sysPath, 'utf8');
      const combined = `${sysCa.trimEnd()}\n${caCertificate.trimEnd()}\n`;
      const outPath = path.join(os.tmpdir(), 'onecli-combined-ca.pem');
      fs.writeFileSync(outPath, combined);
      return outPath;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch /v1/container-config and push Docker/Podman -e/-v flags onto args.
 * Returns false only when OneCLI is unreachable (network / 5xx).
 */
export async function applyContainerConfigV1(
  args: string[],
  options: { combineCaBundle?: boolean; addHostMapping?: boolean; agent?: string } = {},
): Promise<boolean> {
  const { combineCaBundle = true, addHostMapping = true, agent } = options;
  if (!ONECLI_API_KEY) {
    throw new OnecliV1Error(
      'ONECLI_API_KEY is not set. Re-run NanoClaw setup so it can write the local vault key, then restart the worker.',
    );
  }
  const q = agent ? `?agent=${encodeURIComponent(agent)}` : '';
  const url = `${onecliApiBase()}/v1/container-config${q}`;
  let res: Response | undefined;
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      res = await fetch(url, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.warn('OneCLI /v1/container-config unreachable', { err });
      return false;
    }
    // 503 = MITM gateway has not written /app/data/gateway/ca.pem yet.
    if (res.status === 503 && Date.now() < deadline) {
      log.warn('OneCLI gateway CA not ready yet — retrying /v1/container-config');
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    break;
  }
  if (!res) return false;
  if (res.status >= 500) {
    const text = await res.text().catch(() => '');
    log.warn('OneCLI /v1/container-config 5xx', {
      status: res.status,
      body: text.slice(0, 400),
    });
    return false;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OnecliV1Error(
      `OneCLI container-config failed (${res.status}) ${text.slice(0, 400)}`,
      res.status,
      url,
    );
  }
  const config = (await res.json()) as ContainerConfigV1;
  for (const [key, value] of Object.entries(rewriteLocalProxyEnv(config.env ?? {}))) {
    args.push('-e', `${key}=${value}`);
  }
  if (config.caCertificate && config.caCertificateContainerPath) {
    const hostCaPath = writeCaCertificate(config.caCertificate);
    args.push('-v', `${hostCaPath}:${config.caCertificateContainerPath}:ro`);
    if (combineCaBundle) {
      const combinedPath = buildCombinedCaBundle(config.caCertificate);
      if (combinedPath) {
        args.push('-e', 'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem');
        args.push('-e', 'DENO_CERT=/tmp/onecli-combined-ca.pem');
        args.push('-v', `${combinedPath}:/tmp/onecli-combined-ca.pem:ro`);
      }
    }
  }
  if (addHostMapping && process.platform === 'linux') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  return true;
}

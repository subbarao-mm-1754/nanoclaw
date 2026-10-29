/**
 * OneCLI Community 2.x client (GET/POST /v1/…).
 *
 * NanoClaw still depends on @onecli-sh/sdk 0.5.0, which calls the retired
 * /api/agents and /api/container-config paths on the dashboard port.
 * Community 2.x serves those on the API (10256) under /v1.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';

/** True when ONECLI_URL points at this machine (loopback). */
export function isLocalOnecliUrl(url = ONECLI_URL): boolean {
  const raw = (url ?? '').trim();
  if (!raw) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch {
    return /^(127\.0\.0\.1|localhost|::1)([:/]|$)/i.test(raw);
  }
}

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

/**
 * Shape proxy env for how the agent will reach OneCLI:
 * - Local + join compose network → use Compose DNS `gateway:10255` (OneCLI stays on 127.0.0.1).
 * - Remote OneCLI → leave container-config as returned (already a reachable host).
 */
function rewriteProxyEnvForAgent(
  env: Record<string, string>,
  mode: 'compose-network' | 'as-is',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (mode === 'compose-network') {
      out[key] = value.replace(/@host\.docker\.internal:10255\b/g, '@gateway:10255');
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Compose project network (default `onecli_onecli`). Override with ONECLI_AGENT_NETWORK. */
export function resolveOnecliAgentNetwork(): string | null {
  const fromEnv = (process.env.ONECLI_AGENT_NETWORK ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync(
      'docker',
      ['inspect', 'onecli-gateway', '--format', '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}}{{end}}'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out) return out.split(/\s+/)[0] ?? null;
  } catch {
    // fall through
  }
  return 'onecli_onecli';
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

interface OnecliAgentV1 {
  id: string;
  name?: string;
  identifier?: string;
}

interface OnecliSecretV1 {
  id: string;
  name?: string;
  type?: string;
  hostPattern?: string | null;
}

function extractList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
  }
  return [];
}

/** List vault secrets (Community 2.x grants model). */
export async function listSecretsV1(): Promise<OnecliSecretV1[]> {
  const res = await v1Fetch('GET', '/v1/secrets');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OnecliV1Error(
      `OneCLI list secrets failed (${res.status}) ${text.slice(0, 400)}`,
      res.status,
      `${onecliApiBase()}/v1/secrets`,
    );
  }
  return extractList<OnecliSecretV1>(await res.json());
}

export async function findAgentIdByIdentifierV1(identifier: string): Promise<string | null> {
  const res = await v1Fetch('GET', '/v1/agents?max=500');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OnecliV1Error(
      `OneCLI list agents failed (${res.status}) ${text.slice(0, 400)}`,
      res.status,
      `${onecliApiBase()}/v1/agents`,
    );
  }
  const agents = extractList<OnecliAgentV1>(await res.json());
  for (const agent of agents) {
    if (agent.identifier === identifier || agent.id === identifier) {
      return typeof agent.id === 'string' ? agent.id : null;
    }
  }
  return null;
}

/**
 * Grant a vault secret to an agent (OneCLI 1.7+).
 * Replaces retired `set-secret-mode all` / `agents set-secrets`.
 */
export async function grantSecretToAgentV1(agentId: string, secretId: string): Promise<void> {
  const res = await v1Fetch('PUT', `/v1/agents/${agentId}/grants/secrets/${secretId}`, {});
  if (res.ok || res.status === 409) return;
  const text = await res.text().catch(() => '');
  throw new OnecliV1Error(
    `OneCLI grant secret failed (${res.status}) ${text.slice(0, 400)}`,
    res.status,
    `${onecliApiBase()}/v1/agents/${agentId}/grants/secrets/${secretId}`,
  );
}

/** Grant every vault secret to the agent (Anthropic + MCP/generic hosts). */
export async function grantAllVaultSecretsToAgentV1(agentId: string): Promise<void> {
  const secrets = await listSecretsV1();
  for (const secret of secrets) {
    if (!secret.id) continue;
    await grantSecretToAgentV1(agentId, secret.id);
  }
}

const ENSURE_AGENT_RETRY_DELAYS_MS = [2000, 4000, 8000];

/** OneCLI can briefly lose its database (e.g. container network churn); retry 5xx and network errors. */
async function postAgentWithRetry(input: { name: string; identifier: string }): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let fetchErr: unknown = null;
    try {
      res = await v1Fetch('POST', '/v1/agents', { name: input.name, identifier: input.identifier });
    } catch (err) {
      fetchErr = err;
    }
    const transient = fetchErr !== null || (res !== null && res.status >= 500);
    const delay = ENSURE_AGENT_RETRY_DELAYS_MS[attempt];
    if (!transient || delay === undefined) {
      if (fetchErr !== null) throw fetchErr;
      return res!;
    }
    log.warn('OneCLI ensureAgent transient failure — retrying', {
      identifier: input.identifier,
      status: res?.status,
      attempt: attempt + 1,
      delayMs: delay,
    });
    await new Promise((r) => setTimeout(r, delay));
  }
}

export async function ensureAgentV1(input: { name: string; identifier: string }): Promise<void> {
  if (!ONECLI_API_KEY) {
    throw new OnecliV1Error(
      'ONECLI_API_KEY is not set. Re-run NanoClaw setup so it can write the local vault key, then restart gateway and worker.',
    );
  }
  const res = await postAgentWithRetry(input);
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    throw new OnecliV1Error(
      `OneCLI ensureAgent failed (${res.status}) ${text.slice(0, 400)}`,
      res.status,
      `${onecliApiBase()}/v1/agents`,
    );
  }

  // OneCLI 1.7+ agents use grants only (secret-mode "all" is Gone). Without
  // explicit grants, Anthropic injection fails and the container retries forever.
  try {
    const agentId = await findAgentIdByIdentifierV1(input.identifier);
    if (agentId) {
      await grantAllVaultSecretsToAgentV1(agentId);
    } else {
      log.warn('OneCLI agent missing after ensure; cannot grant vault secrets', {
        identifier: input.identifier,
      });
    }
  } catch (err) {
    log.warn('OneCLI vault secret grants failed after ensureAgent', {
      identifier: input.identifier,
      err,
    });
  }
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

  // Local OneCLI: join its compose network and talk to `gateway:10255` so the
  // credential proxy can stay bound to 127.0.0.1. Remote OneCLI: use the proxy
  // host from container-config unchanged (works when the vault runs elsewhere).
  const joinComposeNetwork = isLocalOnecliUrl();
  const network = joinComposeNetwork ? resolveOnecliAgentNetwork() : null;
  if (joinComposeNetwork && network) {
    args.push('--network', network);
    log.info('OneCLI local: attaching agent container to compose network', { network });
  }

  const proxyMode = joinComposeNetwork && network ? 'compose-network' : 'as-is';
  for (const [key, value] of Object.entries(rewriteProxyEnvForAgent(config.env ?? {}, proxyMode))) {
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
  // host.docker.internal mapping only needed when not on the OneCLI network.
  if (addHostMapping && !joinComposeNetwork && process.platform === 'linux') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  return true;
}

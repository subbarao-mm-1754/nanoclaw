/**
 * Unattended local OneCLI owner + oc_ API key.
 *
 * Community 2.x requires a Bearer key for /v1 (agents, secrets, container-config).
 * The dashboard uses a browser cookie; NanoClaw's worker has none, so setup
 * creates a local account, provisions the workspace, and writes ONECLI_API_KEY.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  LOCAL_API_URL,
  LOCAL_GATEWAY_URL,
  onecliHomeDir,
} from './onecli-local.js';

const BOOTSTRAP_EMAIL = 'nanoclaw@local.test';
const BOOTSTRAP_NAME = 'NanoClaw';

export interface BootstrapResult {
  ok: boolean;
  apiKey?: string;
  workspaceId?: string;
  createdAccount?: boolean;
  reusedKey?: boolean;
  error?: string;
}

function nanoclawEnvPath(): string {
  return path.join(process.cwd(), '.env');
}

function onecliEnvPath(): string {
  return path.join(onecliHomeDir(), '.env');
}

export function readDotEnvKey(file: string, key: string): string | null {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

export function writeDotEnvKey(file: string, key: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) content = content.replace(re, line);
  else content = content.trimEnd() + (content ? '\n' : '') + `${line}\n`;
  const mode = file.endsWith(`${path.sep}.env`) || path.basename(file) === '.env' ? 0o600 : undefined;
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function cookieHeader(setCookies: string[]): string {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const sc of setCookies) {
    const part = sc.split(';')[0]?.trim();
    if (!part || !part.includes('=')) continue;
    const name = part.slice(0, part.indexOf('='));
    if (seen.has(name)) continue;
    seen.add(name);
    pairs.push(part);
  }
  return pairs.join('; ');
}

function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function extractApiKey(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.apiKey === 'string' && obj.apiKey.startsWith('oc_')) return obj.apiKey;
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.apiKey === 'string' && data.apiKey.startsWith('oc_')) return data.apiKey;
  }
  return null;
}

function extractWorkspaceId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['workspaceId', 'projectId']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }
  if (obj.data && typeof obj.data === 'object') {
    return extractWorkspaceId(obj.data);
  }
  return null;
}

async function jsonOrText(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function apiFetch(
  url: string,
  init: RequestInit & { origin?: string },
): Promise<Response> {
  const origin = init.origin ?? LOCAL_GATEWAY_URL;
  const headers = new Headers(init.headers);
  if (!headers.has('Origin')) headers.set('Origin', origin);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
}

async function keyWorks(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_API_URL}/v1/user`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function loadOrCreateOwnerPassword(): { email: string; password: string } {
  const envFile = onecliEnvPath();
  const email = readDotEnvKey(envFile, 'ONECLI_BOOTSTRAP_EMAIL') ?? BOOTSTRAP_EMAIL;
  let password = readDotEnvKey(envFile, 'ONECLI_BOOTSTRAP_PASSWORD');
  if (!password || password.length < 12) {
    password = crypto.randomBytes(24).toString('base64url');
  }
  writeDotEnvKey(envFile, 'ONECLI_BOOTSTRAP_EMAIL', email);
  writeDotEnvKey(envFile, 'ONECLI_BOOTSTRAP_PASSWORD', password);
  return { email, password };
}

async function signUpOrIn(
  email: string,
  password: string,
): Promise<{ cookie: string; created: boolean; error?: string }> {
  const origins = [LOCAL_GATEWAY_URL, LOCAL_API_URL];
  let lastErr = 'sign-up failed';
  let created = false;
  let cookie = '';

  for (const origin of origins) {
    const signup = await apiFetch(`${LOCAL_API_URL}/auth/sign-up/email`, {
      method: 'POST',
      origin,
      body: JSON.stringify({ email, password, name: BOOTSTRAP_NAME }),
    });
    const signupCookies = getSetCookies(signup);
    if (signup.ok || signup.status === 200) {
      created = true;
      cookie = cookieHeader(signupCookies);
      if (cookie) return { cookie, created };
    }
    const signupBody = await jsonOrText(signup);
    const msg = JSON.stringify(signupBody).toLowerCase();
    const taken =
      signup.status === 422 ||
      signup.status === 409 ||
      /already|exist|taken|user_already/i.test(msg);

    const signin = await apiFetch(`${LOCAL_API_URL}/auth/sign-in/email`, {
      method: 'POST',
      origin,
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    const signinCookies = getSetCookies(signin);
    if (signin.ok) {
      cookie = cookieHeader(signinCookies);
      if (cookie) return { cookie, created: created && !taken };
    }
    lastErr = `auth HTTP ${signup.status}/${signin.status}`;
    if (!taken && signup.status === 403) continue;
  }

  return { cookie, created, error: cookie ? undefined : lastErr };
}

/**
 * Ensure NanoClaw .env has a working ONECLI_API_KEY for the local vault.
 * Never logs the key or password.
 */
export async function ensureLocalOnecliApiKey(): Promise<BootstrapResult> {
  const existing =
    readDotEnvKey(nanoclawEnvPath(), 'ONECLI_API_KEY') ??
    readDotEnvKey(onecliEnvPath(), 'ONECLI_API_KEY');
  if (existing?.startsWith('oc_') && (await keyWorks(existing))) {
    writeDotEnvKey(nanoclawEnvPath(), 'ONECLI_API_KEY', existing);
    return { ok: true, apiKey: existing, reusedKey: true };
  }

  const { email, password } = loadOrCreateOwnerPassword();
  const auth = await signUpOrIn(email, password);
  if (!auth.cookie) {
    return { ok: false, error: auth.error ?? 'could not sign in to local OneCLI' };
  }

  const sessionRes = await apiFetch(`${LOCAL_API_URL}/v1/auth/session`, {
    method: 'GET',
    headers: { Cookie: auth.cookie },
  });
  const sessionBody = await jsonOrText(sessionRes);
  if (!sessionRes.ok) {
    return {
      ok: false,
      error: `GET /v1/auth/session ${sessionRes.status}`,
    };
  }
  const workspaceId = extractWorkspaceId(sessionBody);
  if (!workspaceId) {
    return { ok: false, error: 'OneCLI session did not return a workspace id' };
  }

  const keyRes = await apiFetch(`${LOCAL_API_URL}/v1/user/api-key`, {
    method: 'GET',
    headers: {
      Cookie: auth.cookie,
      'X-Workspace-Id': workspaceId,
      'X-Project-Id': workspaceId,
    },
  });
  const keyBody = await jsonOrText(keyRes);
  const apiKey = extractApiKey(keyBody);
  if (!keyRes.ok || !apiKey) {
    return {
      ok: false,
      error: `GET /v1/user/api-key ${keyRes.status}`,
    };
  }

  writeDotEnvKey(nanoclawEnvPath(), 'ONECLI_API_KEY', apiKey);
  writeDotEnvKey(onecliEnvPath(), 'ONECLI_API_KEY', apiKey);

  try {
    await fetch(`${LOCAL_API_URL}/v1/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': workspaceId,
      },
      body: JSON.stringify({ name: 'NanoClaw', identifier: 'nanoclaw' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Vault identity is optional; /build creates agents later.
  }

  return {
    ok: true,
    apiKey,
    workspaceId,
    createdAccount: auth.created,
  };
}

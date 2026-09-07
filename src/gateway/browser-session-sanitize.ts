/**
 * Minimize Playwright storageState before persisting.
 *
 * Keep only cookies scoped to the target origin's registrable host tree.
 * Drop unrelated sites' cookies, analytics noise when obvious, and
 * localStorage/sessionStorage by default (cookies are enough for most
 * session restores; storage is a larger exfil surface).
 */
export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

const MAX_COOKIE_VALUE_BYTES = 8 * 1024;
const MAX_COOKIES = 80;

function cookieDomainMatchesHost(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  if (!domain) return false;
  return h === domain || h.endsWith(`.${domain}`);
}

function looksLikeTrackingCookie(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith('_ga') ||
    n.startsWith('_gid') ||
    n.startsWith('_gat') ||
    n.startsWith('_gcl') ||
    n.startsWith('_fbp') ||
    n.startsWith('_fbc') ||
    n.startsWith('amp_') ||
    n.startsWith('_hj') ||
    n === '__utm' ||
    n.startsWith('__utm') ||
    n.startsWith('utm_')
  );
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  const s = String(value ?? 'Lax');
  if (s === 'Strict' || s === 'Lax' || s === 'None') return s;
  return 'Lax';
}

/**
 * Reduce a raw storageState to the minimum needed for the given origin.
 * Returns JSON string ready for gateway_browser_sessions.auth_json.
 */
export function sanitizeStorageStateForOrigin(origin: string, raw: unknown): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new Error(`Invalid origin: ${origin}`);
  }

  const input =
    typeof raw === 'string'
      ? (JSON.parse(raw) as { cookies?: unknown[]; origins?: unknown[] })
      : (raw as { cookies?: unknown[]; origins?: unknown[] });

  if (!input || typeof input !== 'object') {
    throw new Error('storageState must be an object');
  }

  const cookiesIn = Array.isArray(input.cookies) ? input.cookies : [];
  const cookies: StorageCookie[] = [];

  for (const c of cookiesIn) {
    if (!c || typeof c !== 'object') continue;
    const row = c as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name : '';
    const value = typeof row.value === 'string' ? row.value : '';
    const domain = typeof row.domain === 'string' ? row.domain : '';
    if (!name || !domain) continue;
    if (!cookieDomainMatchesHost(domain, host)) continue;
    if (looksLikeTrackingCookie(name)) continue;
    if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_VALUE_BYTES) continue;

    cookies.push({
      name,
      value,
      domain,
      path: typeof row.path === 'string' && row.path ? row.path : '/',
      expires: typeof row.expires === 'number' ? row.expires : -1,
      httpOnly: Boolean(row.httpOnly),
      secure: Boolean(row.secure),
      sameSite: normalizeSameSite(row.sameSite),
    });
    if (cookies.length >= MAX_COOKIES) break;
  }

  if (cookies.length === 0) {
    throw new Error(
      `No cookies for ${host} after login — stay on the site until you are logged in, then confirm again.`,
    );
  }

  const state: StorageState = { cookies, origins: [] };
  return JSON.stringify(state);
}

export function cookieHostsForOrigin(origin: string): string {
  return new URL(origin).hostname;
}

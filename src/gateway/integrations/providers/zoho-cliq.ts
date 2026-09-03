/**
 * Zoho Cliq channel OAuth provider.
 *
 * Shared Client ID / Secret live in gateway.db (`gateway_settings`), set via
 * the operator API — not committed in the repo. Optional env / `.env` is only
 * a fallback for local ops. Each user still stores their own refresh token.
 */
import { readEnvFile } from '../../../env.js';
import { getGatewaySetting, setGatewaySetting, deleteGatewaySetting } from '../../store/settings.js';
import type { OAuthProviderConfig, TokenSet } from '../types.js';
import { pkceChallenge } from '../pkce.js';

export const ZOHO_CLIQ_PROVIDER_ID = 'zoho-cliq';

export const SETTING_CLIENT_ID = 'zoho_cliq.oauth_client_id';
export const SETTING_CLIENT_SECRET = 'zoho_cliq.oauth_client_secret';
export const SETTING_API_URL = 'zoho_cliq.api_url';
export const SETTING_ACCOUNTS_URL = 'zoho_cliq.accounts_url';
export const SETTING_BOT_UNIQUE_NAME = 'zoho_cliq.bot_unique_name';
export const SETTING_CHANNEL_ENDPOINT = 'zoho_cliq.channel_endpoint';

export const ZOHO_CLIQ_DEFAULT_SCOPES = [
  'ZohoCliq.Webhooks.CREATE',
  'ZohoCliq.Messages.ALL',
  'ZohoCliq.Chats.READ',
  'ZohoCliq.Channels.READ',
  'ZohoCliq.Profile.READ',
  'ZohoCliq.Bots.READ',
];

const ENV_KEYS = [
  'GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_ID',
  'GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_SECRET',
  'GATEWAY_OAUTH_ZOHO_CLIQ_ACCOUNTS_URL',
  'GATEWAY_OAUTH_ZOHO_CLIQ_API_URL',
  'GATEWAY_OAUTH_ZOHO_CLIQ_SCOPES',
  'ZOHO_CLIQ_CLIENT_ID',
  'ZOHO_CLIQ_CLIENT_SECRET',
  'ZOHO_CLIQ_ACCOUNTS_URL',
  'ZOHO_CLIQ_API_URL',
  'ZOHO_CLIQ_BOT_UNIQUE_NAME',
  'ZOHO_CLIQ_CHANNEL_ENDPOINT',
  'GATEWAY_ZOHO_CLIQ_BOT_UNIQUE_NAME',
  'GATEWAY_ZOHO_CLIQ_CHANNEL_ENDPOINT',
] as const;

/** Optional env / `.env` fallback (not preferred for secrets). */
function envGet(name: (typeof ENV_KEYS)[number]): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  const fromFile = readEnvFile([...ENV_KEYS])[name]?.trim();
  return fromFile || undefined;
}

function dbGet(key: string): string | undefined {
  try {
    return getGatewaySetting(key)?.trim() || undefined;
  } catch {
    // DB not initialized yet (e.g. import-time in tests before initGatewayDb)
    return undefined;
  }
}

export function cliqAccountsBase(): string {
  const explicit =
    dbGet(SETTING_ACCOUNTS_URL) ||
    envGet('GATEWAY_OAUTH_ZOHO_CLIQ_ACCOUNTS_URL') ||
    envGet('ZOHO_CLIQ_ACCOUNTS_URL');
  if (explicit) return explicit.replace(/\/$/, '');

  return accountsBaseFromApiBase(cliqApiBase());
}

export function cliqApiBase(): string {
  return (
    dbGet(SETTING_API_URL) ||
    envGet('GATEWAY_OAUTH_ZOHO_CLIQ_API_URL') ||
    envGet('ZOHO_CLIQ_API_URL') ||
    'https://cliq.zoho.com'
  ).replace(/\/$/, '');
}

/** Derive Zoho Accounts host from a Cliq API base (cliq.zoho.in → accounts.zoho.in). */
export function accountsBaseFromApiBase(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    return `${url.protocol}//${url.hostname.replace(/^cliq\./, 'accounts.')}`;
  } catch {
    return 'https://accounts.zoho.com';
  }
}

/** Derive Cliq API host from an Accounts base (accounts.zoho.in → cliq.zoho.in). */
export function cliqApiBaseFromAccountsBase(accountsBase: string): string {
  try {
    const url = new URL(accountsBase);
    return `${url.protocol}//${url.hostname.replace(/^accounts\./, 'cliq.')}`;
  } catch {
    return 'https://cliq.zoho.com';
  }
}

/**
 * Map Zoho OAuth `location` query param to the Accounts host for that DC.
 * @see https://www.zoho.com/books/api/v3/oauth/ (Multi DC support)
 */
export function accountsBaseFromLocation(location: string): string | null {
  const loc = location.trim().toLowerCase();
  const map: Record<string, string> = {
    us: 'https://accounts.zoho.com',
    com: 'https://accounts.zoho.com',
    eu: 'https://accounts.zoho.eu',
    in: 'https://accounts.zoho.in',
    au: 'https://accounts.zoho.com.au',
    'com.au': 'https://accounts.zoho.com.au',
    jp: 'https://accounts.zoho.jp',
    ca: 'https://accounts.zohocloud.ca',
    sa: 'https://accounts.zoho.sa',
    cn: 'https://accounts.zoho.com.cn',
    'com.cn': 'https://accounts.zoho.com.cn',
    uk: 'https://accounts.zoho.uk',
  };
  return map[loc] ?? null;
}

/**
 * Resolve the Accounts DC from Zoho's OAuth redirect params.
 * Prefer `accounts-server`; fall back to `location`.
 */
export function resolveAccountsBaseFromOAuthRedirect(input: {
  accountsServer?: string | null;
  location?: string | null;
}): string | null {
  const server = input.accountsServer?.trim();
  if (server) {
    try {
      return new URL(server).origin;
    } catch {
      /* fall through */
    }
  }
  if (input.location?.trim()) {
    return accountsBaseFromLocation(input.location);
  }
  return null;
}

/** Normalize an Accounts URL origin (strip path / trailing slash). */
export function normalizeAccountsBase(raw: string): string {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return raw.trim().replace(/\/$/, '');
  }
}

function hostPattern(): string {
  try {
    return new URL(cliqApiBase()).hostname;
  } catch {
    return 'cliq.zoho.com';
  }
}

function scopes(): string[] {
  const raw = envGet('GATEWAY_OAUTH_ZOHO_CLIQ_SCOPES');
  if (raw) {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...ZOHO_CLIQ_DEFAULT_SCOPES];
}

export function cliqClientId(): string {
  const value =
    dbGet(SETTING_CLIENT_ID) ||
    envGet('GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_ID') ||
    envGet('ZOHO_CLIQ_CLIENT_ID');
  if (!value) throw new Error('Zoho Cliq OAuth client id is not configured');
  return value;
}

export function cliqClientSecret(): string {
  const value =
    dbGet(SETTING_CLIENT_SECRET) ||
    envGet('GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_SECRET') ||
    envGet('ZOHO_CLIQ_CLIENT_SECRET');
  if (!value) throw new Error('Zoho Cliq OAuth client secret is not configured');
  return value;
}

/** True when the gateway OAuth app credentials are configured. */
export function isZohoCliqOAuthAppConfigured(): boolean {
  try {
    cliqClientId();
    cliqClientSecret();
    return true;
  } catch {
    return false;
  }
}

export function defaultCliqBotUniqueName(): string | undefined {
  return (
    dbGet(SETTING_BOT_UNIQUE_NAME) ||
    envGet('ZOHO_CLIQ_BOT_UNIQUE_NAME') ||
    envGet('GATEWAY_ZOHO_CLIQ_BOT_UNIQUE_NAME')
  );
}

export function defaultCliqChannelEndpoint(): string | undefined {
  return (
    dbGet(SETTING_CHANNEL_ENDPOINT) ||
    envGet('ZOHO_CLIQ_CHANNEL_ENDPOINT') ||
    envGet('GATEWAY_ZOHO_CLIQ_CHANNEL_ENDPOINT')
  );
}

export type CliqOAuthAppPublic = {
  configured: boolean;
  client_id: string | null;
  has_client_secret: boolean;
  api_url: string;
  accounts_url: string;
  bot_unique_name: string | null;
  channel_endpoint: string | null;
  source: 'gateway_db' | 'env' | 'none';
};

export function getCliqOAuthAppPublic(): CliqOAuthAppPublic {
  const fromDb = Boolean(dbGet(SETTING_CLIENT_ID) && dbGet(SETTING_CLIENT_SECRET));
  const fromEnv = Boolean(
    (envGet('GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_ID') || envGet('ZOHO_CLIQ_CLIENT_ID')) &&
      (envGet('GATEWAY_OAUTH_ZOHO_CLIQ_CLIENT_SECRET') || envGet('ZOHO_CLIQ_CLIENT_SECRET')),
  );
  let clientId: string | null = null;
  try {
    clientId = cliqClientId();
  } catch {
    clientId = null;
  }
  return {
    configured: isZohoCliqOAuthAppConfigured(),
    client_id: clientId,
    has_client_secret: isZohoCliqOAuthAppConfigured(),
    api_url: cliqApiBase(),
    accounts_url: cliqAccountsBase(),
    bot_unique_name: defaultCliqBotUniqueName() ?? null,
    channel_endpoint: defaultCliqChannelEndpoint() ?? null,
    source: fromDb ? 'gateway_db' : fromEnv ? 'env' : 'none',
  };
}

/** Persist shared OAuth app credentials in gateway.db (never returns the secret). */
export function setCliqOAuthApp(input: {
  client_id: string;
  client_secret: string;
  api_url?: string | null;
  accounts_url?: string | null;
  bot_unique_name?: string | null;
  channel_endpoint?: string | null;
}): CliqOAuthAppPublic {
  const clientId = input.client_id.trim();
  const clientSecret = input.client_secret.trim();
  if (!clientId || !clientSecret) {
    throw new Error('client_id and client_secret are required');
  }
  setGatewaySetting(SETTING_CLIENT_ID, clientId);
  setGatewaySetting(SETTING_CLIENT_SECRET, clientSecret);
  if (input.api_url !== undefined) {
    if (input.api_url?.trim()) {
      const apiUrl = input.api_url.trim().replace(/\/$/, '');
      setGatewaySetting(SETTING_API_URL, apiUrl);
      // Keep Accounts DC aligned with Cliq API DC unless explicitly overridden below.
      if (input.accounts_url === undefined) {
        setGatewaySetting(SETTING_ACCOUNTS_URL, accountsBaseFromApiBase(apiUrl));
      }
    } else deleteGatewaySetting(SETTING_API_URL);
  }
  if (input.accounts_url !== undefined) {
    if (input.accounts_url?.trim()) setGatewaySetting(SETTING_ACCOUNTS_URL, input.accounts_url.trim());
    else deleteGatewaySetting(SETTING_ACCOUNTS_URL);
  }
  if (input.bot_unique_name !== undefined) {
    if (input.bot_unique_name?.trim()) {
      setGatewaySetting(SETTING_BOT_UNIQUE_NAME, input.bot_unique_name.trim());
    } else deleteGatewaySetting(SETTING_BOT_UNIQUE_NAME);
  }
  if (input.channel_endpoint !== undefined) {
    if (input.channel_endpoint?.trim()) {
      setGatewaySetting(SETTING_CHANNEL_ENDPOINT, input.channel_endpoint.trim());
    } else deleteGatewaySetting(SETTING_CHANNEL_ENDPOINT);
  }
  return getCliqOAuthAppPublic();
}

async function tokenRequest(
  params: Record<string, string>,
  accountsBase = cliqAccountsBase(),
): Promise<TokenSet> {
  const base = accountsBase.replace(/\/$/, '');
  const body = new URLSearchParams(params);
  const res = await fetch(`${base}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new Error(
      `Zoho Cliq token exchange failed (${res.status}) at ${base}: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expires_in:
      typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in) || undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    metadata: { api_domain: json.api_domain ?? null, accounts_base: base },
  };
}

/** Refresh using an explicit Accounts DC (must match where the refresh token was issued). */
export async function refreshCliqToken(
  refreshToken: string,
  accountsBase?: string,
): Promise<TokenSet> {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: cliqClientId(),
      client_secret: cliqClientSecret(),
      refresh_token: refreshToken,
    },
    accountsBase || cliqAccountsBase(),
  );
}

export const zohoCliqProvider: OAuthProviderConfig = {
  id: ZOHO_CLIQ_PROVIDER_ID,
  displayName: 'Zoho Cliq',
  get hostPattern() {
    return hostPattern();
  },
  headerName: 'Authorization',
  valueFormat: 'Zoho-oauthtoken {value}',
  get scopes() {
    return scopes();
  },

  buildAuthorizeUrl({ redirectUri, state, codeVerifier, scopes: requestedScopes }) {
    const params = new URLSearchParams({
      scope: requestedScopes.join(','),
      client_id: cliqClientId(),
      response_type: 'code',
      access_type: 'offline',
      redirect_uri: redirectUri,
      state,
      prompt: 'consent',
    });
    if (codeVerifier) {
      params.set('code_challenge', pkceChallenge(codeVerifier));
      params.set('code_challenge_method', 'S256');
    }
    return `${cliqAccountsBase()}/oauth/v2/auth?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri, codeVerifier, accountsBase }) {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: cliqClientId(),
      client_secret: cliqClientSecret(),
      redirect_uri: redirectUri,
      code,
    };
    if (codeVerifier) params.code_verifier = codeVerifier;
    // Multi-DC: exchange on the Accounts host from the OAuth redirect when present.
    const base = accountsBase?.trim()
      ? normalizeAccountsBase(accountsBase)
      : cliqAccountsBase();
    return tokenRequest(params, base);
  },

  async refresh(refreshToken) {
    return refreshCliqToken(refreshToken);
  },
};

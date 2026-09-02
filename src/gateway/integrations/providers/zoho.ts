import type { OAuthProviderConfig, TokenSet } from '../types.js';
import { newCodeVerifier, pkceChallenge } from '../pkce.js';

export { newCodeVerifier, pkceChallenge };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Zoho OAuth`);
  return value;
}

function accountsBase(): string {
  return (
    process.env.GATEWAY_OAUTH_ZOHO_ACCOUNTS_URL?.trim() ||
    process.env.ZOHO_ACCOUNTS_URL?.trim() ||
    'https://accounts.zoho.com'
  ).replace(/\/$/, '');
}

function hostPattern(): string {
  return (
    process.env.GATEWAY_OAUTH_ZOHO_HOST_PATTERN?.trim() ||
    process.env.ZOHO_API_HOST_PATTERN?.trim() ||
    'www.zohoapis.com'
  );
}

function scopes(): string[] {
  const raw =
    process.env.GATEWAY_OAUTH_ZOHO_SCOPES?.trim() ||
    'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL';
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clientId(): string {
  return (
    process.env.GATEWAY_OAUTH_ZOHO_CLIENT_ID?.trim() ||
    process.env.ZOHO_MCP_CLIENT_ID?.trim() ||
    requireEnv('GATEWAY_OAUTH_ZOHO_CLIENT_ID')
  );
}

function clientSecret(): string {
  return (
    process.env.GATEWAY_OAUTH_ZOHO_CLIENT_SECRET?.trim() ||
    process.env.ZOHO_MCP_CLIENT_SECRET?.trim() ||
    requireEnv('GATEWAY_OAUTH_ZOHO_CLIENT_SECRET')
  );
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new Error(
      `Zoho token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expires_in:
      typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in) || undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    metadata: { api_domain: json.api_domain ?? null },
  };
}

export const zohoProvider: OAuthProviderConfig = {
  id: 'zoho',
  displayName: 'Zoho',
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
      client_id: clientId(),
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
    return `${accountsBase()}/oauth/v2/auth?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      code,
    };
    if (codeVerifier) params.code_verifier = codeVerifier;
    return tokenRequest(params);
  },

  async refresh(refreshToken) {
    return tokenRequest({
      grant_type: 'refresh_token',
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
    });
  },
};

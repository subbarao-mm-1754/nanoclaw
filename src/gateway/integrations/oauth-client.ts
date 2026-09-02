/**
 * Generic OAuth authorize / token exchange / refresh (RFC 6749 + PKCE).
 * Works with clients obtained via DCR or pre-registration.
 */
import { pkceChallenge } from './pkce.js';
import type { ClientRegistration } from './registration.js';
import type { TokenSet } from './types.js';

export function buildAuthorizeUrl(input: {
  registration: ClientRegistration;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
  resource?: string | null;
  extraParams?: Record<string, string>;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.registration.client_id,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: 'S256',
  });
  if (input.scopes.length > 0) {
    params.set('scope', input.scopes.join(' '));
  }
  // MCP / RFC 8707 resource indicator when known
  if (input.resource) {
    params.set('resource', input.resource);
  }
  // Prefer refresh tokens when the AS understands offline_access
  if (input.scopes.includes('offline_access') || !input.scopes.length) {
    // Many ASes ignore unknown params; Zoho-style use access_type
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      params.set(k, v);
    }
  }
  return `${input.registration.authorization_endpoint}?${params.toString()}`;
}

async function tokenRequest(
  registration: ClientRegistration,
  params: Record<string, string>,
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  body.set('client_id', registration.client_id);

  if (
    registration.client_secret &&
    (registration.token_endpoint_auth_method === 'client_secret_post' ||
      registration.token_endpoint_auth_method === 'none' ||
      !registration.token_endpoint_auth_method)
  ) {
    body.set('client_secret', registration.client_secret);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (
    registration.client_secret &&
    registration.token_endpoint_auth_method === 'client_secret_basic'
  ) {
    const basic = Buffer.from(
      `${registration.client_id}:${registration.client_secret}`,
    ).toString('base64');
    headers.Authorization = `Basic ${basic}`;
    body.delete('client_secret');
  }

  const res = await fetch(registration.token_endpoint, {
    method: 'POST',
    headers,
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    throw new Error(
      `Token request failed (${res.status}): ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expires_in:
      typeof json.expires_in === 'number'
        ? json.expires_in
        : Number(json.expires_in) || undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    metadata: {
      raw_keys: Object.keys(json),
    },
  };
}

export async function exchangeAuthorizationCode(input: {
  registration: ClientRegistration;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  };
  if (input.resource) params.resource = input.resource;
  return tokenRequest(input.registration, params);
}

export async function refreshAccessToken(input: {
  registration: ClientRegistration;
  refreshToken: string;
  resource?: string | null;
  scopes?: string[];
}): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  };
  if (input.resource) params.resource = input.resource;
  if (input.scopes?.length) params.scope = input.scopes.join(' ');
  return tokenRequest(input.registration, params);
}

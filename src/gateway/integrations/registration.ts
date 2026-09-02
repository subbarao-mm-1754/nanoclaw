/**
 * OAuth client registration: DCR (RFC 7591) + pre-registration.
 *
 * Priority (localhost-friendly):
 *   1. Existing DB registration for this issuer
 *   2. Explicit pre-registered credentials (API / env)
 *   3. Dynamic Client Registration when registration_endpoint exists
 *
 * CIMD is not implemented here (needs a public HTTPS metadata URL).
 */
import { log } from '../../log.js';
import type { AuthorizationServerMetadata } from './discovery.js';

export type RegistrationMethod = 'dcr' | 'pre_registered';

export interface ClientRegistration {
  issuer: string;
  client_id: string;
  client_secret: string | null;
  registration_method: RegistrationMethod;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  redirect_uris: string[];
  scopes_supported: string[];
  token_endpoint_auth_method: string;
  raw?: Record<string, unknown>;
}

export interface PreRegisteredClient {
  issuer: string;
  client_id: string;
  client_secret?: string | null;
  /** Optional overrides if AS metadata is not fetched yet. */
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes?: string[];
}

export interface EnsureRegistrationInput {
  as: AuthorizationServerMetadata;
  redirectUri: string;
  /** Prefer these credentials when present (pre-registration). */
  preRegistered?: PreRegisteredClient | null;
  /** Already-persisted registration from Gateway DB. */
  existing?: ClientRegistration | null;
  clientName?: string;
}

/**
 * Load pre-registered clients from env.
 *
 * GATEWAY_OAUTH_PRE_REG_JSON='[{"issuer":"https://...","client_id":"...","client_secret":"..."}]'
 *
 * Or per-alias:
 *   GATEWAY_OAUTH_PRE_REG_GITHUB_ISSUER=...
 *   GATEWAY_OAUTH_PRE_REG_GITHUB_CLIENT_ID=...
 *   GATEWAY_OAUTH_PRE_REG_GITHUB_CLIENT_SECRET=...
 */
export function loadPreRegisteredFromEnv(): PreRegisteredClient[] {
  const results: PreRegisteredClient[] = [];
  const json = process.env.GATEWAY_OAUTH_PRE_REG_JSON?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          if (typeof row.issuer === 'string' && typeof row.client_id === 'string') {
            results.push({
              issuer: row.issuer,
              client_id: row.client_id,
              client_secret: typeof row.client_secret === 'string' ? row.client_secret : null,
              authorization_endpoint:
                typeof row.authorization_endpoint === 'string'
                  ? row.authorization_endpoint
                  : undefined,
              token_endpoint: typeof row.token_endpoint === 'string' ? row.token_endpoint : undefined,
              scopes: Array.isArray(row.scopes)
                ? row.scopes.filter((s): s is string => typeof s === 'string')
                : undefined,
            });
          }
        }
      }
    } catch (err) {
      log.warn('Failed to parse GATEWAY_OAUTH_PRE_REG_JSON', { err });
    }
  }

  const aliases = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^GATEWAY_OAUTH_PRE_REG_([A-Z0-9]+)_ISSUER$/);
    if (m) aliases.add(m[1]!);
  }
  for (const alias of aliases) {
    const issuer = process.env[`GATEWAY_OAUTH_PRE_REG_${alias}_ISSUER`]?.trim();
    const clientId = process.env[`GATEWAY_OAUTH_PRE_REG_${alias}_CLIENT_ID`]?.trim();
    if (!issuer || !clientId) continue;
    results.push({
      issuer,
      client_id: clientId,
      client_secret: process.env[`GATEWAY_OAUTH_PRE_REG_${alias}_CLIENT_SECRET`]?.trim() || null,
    });
  }

  return results;
}

export function findPreRegistered(
  issuer: string,
  list: PreRegisteredClient[],
): PreRegisteredClient | null {
  const normalized = issuer.replace(/\/$/, '');
  return (
    list.find((c) => c.issuer.replace(/\/$/, '') === normalized) ??
    list.find((c) => normalized.startsWith(c.issuer.replace(/\/$/, ''))) ??
    null
  );
}

async function registerViaDcr(
  as: AuthorizationServerMetadata,
  redirectUri: string,
  clientName: string,
): Promise<ClientRegistration> {
  if (!as.registration_endpoint) {
    throw new Error(
      `Authorization server ${as.issuer} has no registration_endpoint. Use pre-registration.`,
    );
  }

  const supportsS256 = as.code_challenge_methods_supported?.includes('S256') ?? true;
  const body: Record<string, unknown> = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  if (supportsS256) {
    body.code_challenge_method = 'S256';
  }

  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof raw.client_id !== 'string') {
    // Retry as confidential client if public was rejected
    if (res.status === 400 || res.status === 401) {
      body.token_endpoint_auth_method = 'client_secret_post';
      const retry = await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const retryRaw = (await retry.json().catch(() => ({}))) as Record<string, unknown>;
      if (!retry.ok || typeof retryRaw.client_id !== 'string') {
        throw new Error(
          `DCR failed for ${as.issuer} (${retry.status}): ${JSON.stringify(retryRaw).slice(0, 500)}`,
        );
      }
      return fromDcrResponse(as, redirectUri, retryRaw, 'client_secret_post');
    }
    throw new Error(`DCR failed for ${as.issuer} (${res.status}): ${JSON.stringify(raw).slice(0, 500)}`);
  }

  return fromDcrResponse(
    as,
    redirectUri,
    raw,
    typeof raw.token_endpoint_auth_method === 'string'
      ? raw.token_endpoint_auth_method
      : 'none',
  );
}

function fromDcrResponse(
  as: AuthorizationServerMetadata,
  redirectUri: string,
  raw: Record<string, unknown>,
  authMethod: string,
): ClientRegistration {
  return {
    issuer: as.issuer,
    client_id: raw.client_id as string,
    client_secret: typeof raw.client_secret === 'string' ? raw.client_secret : null,
    registration_method: 'dcr',
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint ?? null,
    redirect_uris: Array.isArray(raw.redirect_uris)
      ? raw.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [redirectUri],
    scopes_supported: as.scopes_supported ?? [],
    token_endpoint_auth_method: authMethod,
    raw,
  };
}

function fromPreRegistered(
  as: AuthorizationServerMetadata,
  pre: PreRegisteredClient,
  redirectUri: string,
): ClientRegistration {
  return {
    issuer: as.issuer,
    client_id: pre.client_id,
    client_secret: pre.client_secret ?? null,
    registration_method: 'pre_registered',
    authorization_endpoint: pre.authorization_endpoint ?? as.authorization_endpoint,
    token_endpoint: pre.token_endpoint ?? as.token_endpoint,
    registration_endpoint: as.registration_endpoint ?? null,
    redirect_uris: [redirectUri],
    scopes_supported: pre.scopes ?? as.scopes_supported ?? [],
    token_endpoint_auth_method: pre.client_secret ? 'client_secret_post' : 'none',
  };
}

/**
 * Resolve OAuth client credentials for an authorization server.
 */
export async function ensureClientRegistration(
  input: EnsureRegistrationInput,
): Promise<ClientRegistration> {
  const { as, redirectUri, existing, preRegistered } = input;
  const clientName = input.clientName ?? 'NanoClaw Gateway';

  if (existing && existing.client_id) {
    return {
      ...existing,
      authorization_endpoint: as.authorization_endpoint || existing.authorization_endpoint,
      token_endpoint: as.token_endpoint || existing.token_endpoint,
    };
  }

  if (preRegistered?.client_id) {
    log.info('Using pre-registered OAuth client', { issuer: as.issuer });
    return fromPreRegistered(as, preRegistered, redirectUri);
  }

  const fromEnv = findPreRegistered(as.issuer, loadPreRegisteredFromEnv());
  if (fromEnv) {
    log.info('Using pre-registered OAuth client from env', { issuer: as.issuer });
    return fromPreRegistered(as, fromEnv, redirectUri);
  }

  if (as.registration_endpoint) {
    log.info('Registering OAuth client via DCR', {
      issuer: as.issuer,
      registration_endpoint: as.registration_endpoint,
    });
    return registerViaDcr(as, redirectUri, clientName);
  }

  throw new Error(
    `No OAuth client for ${as.issuer}. Provide pre-registered credentials ` +
      `(POST /v1/integrations/registrations or GATEWAY_OAUTH_PRE_REG_*) ` +
      `or use an authorization server that supports Dynamic Client Registration.`,
  );
}

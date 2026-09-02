/**
 * OAuth / remote-MCP discovery for the Gateway broker.
 *
 * Flow (MCP Authorization):
 *   1. Normalize Zoho-hosted URLs (?key= → path form)
 *   2. Try WWW-Authenticate resource_metadata on the MCP URL (401)
 *   3. GET Protected Resource Metadata well-known URLs
 *   4. GET Authorization Server Metadata (RFC 8414) + OIDC fallback
 *   5. Zoho-hosted fallback: synthesize PRM → accounts.zoho.* via OIDC
 */
import { log } from '../../log.js';
import {
  isZohoHostedMcpUrl,
  normalizeZohoMcpUrl,
  zohoAccountsIssuerFromMcpUrl,
} from './zoho-hosted.js';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  raw: Record<string, unknown>;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  /** MCP / newer AS advertise CIMD support here. */
  client_id_metadata_document_supported?: boolean;
  raw: Record<string, unknown>;
}

export interface DiscoveryResult {
  mcpUrl: string;
  /** Canonical URL to use for MCP calls (may differ from input after Zoho normalize). */
  canonicalMcpUrl: string;
  resource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  /** Hostname used for OneCLI host-pattern injection. */
  hostPattern: string;
  /** Suggested scopes: resource scopes ∩ AS scopes (or resource scopes). */
  scopes: string[];
  /** True when this looks like Zoho-hosted MCP. */
  zohoHosted: boolean;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function hostPatternFromUrl(url: string): string {
  return new URL(url).hostname;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed (${res.status}): ${body.slice(0, 400)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function parseProtectedResource(raw: Record<string, unknown>, fallbackResource: string): ProtectedResourceMetadata {
  const servers = raw.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('missing authorization_servers');
  }
  return {
    resource: typeof raw.resource === 'string' ? raw.resource : fallbackResource,
    authorization_servers: servers.filter((s): s is string => typeof s === 'string'),
    scopes_supported: Array.isArray(raw.scopes_supported)
      ? raw.scopes_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    bearer_methods_supported: Array.isArray(raw.bearer_methods_supported)
      ? raw.bearer_methods_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    raw,
  };
}

/**
 * Build candidate PRM URLs per RFC 9728 / MCP guidance.
 * Also tries query-key rewritten path candidates for Zoho.
 */
export function protectedResourceMetadataUrls(mcpUrl: string): string[] {
  const normalized = normalizeZohoMcpUrl(mcpUrl);
  const urls: string[] = [];
  const seen = new Set<string>();

  const addFor = (target: string) => {
    const u = new URL(target);
    const origin = originOf(target);
    const path = u.pathname.replace(/\/$/, '') || '';
    const candidates: string[] = [];
    if (path && path !== '/') {
      candidates.push(`${origin}/.well-known/oauth-protected-resource${path}`);
    }
    candidates.push(`${origin}/.well-known/oauth-protected-resource`);
    for (const c of candidates) {
      if (!seen.has(c)) {
        seen.add(c);
        urls.push(c);
      }
    }
  };

  addFor(normalized);
  if (normalized !== mcpUrl) addFor(mcpUrl);
  return urls;
}

export function authorizationServerMetadataUrls(issuer: string): string[] {
  const base = stripTrailingSlash(issuer);
  const u = new URL(base);
  const urls: string[] = [];
  if (u.pathname && u.pathname !== '/') {
    urls.push(
      `${u.origin}/.well-known/oauth-authorization-server${u.pathname}`,
      `${u.origin}/.well-known/openid-configuration${u.pathname}`,
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    );
  } else {
    urls.push(
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    );
  }
  return urls;
}

/** Parse resource_metadata= from WWW-Authenticate (RFC 9728). */
export function parseResourceMetadataFromWwwAuthenticate(header: string | null): string | null {
  if (!header) return null;
  // resource_metadata="https://..." or resource_metadata=https://...
  const m = header.match(/resource_metadata\s*=\s*"([^"]+)"/i) ??
    header.match(/resource_metadata\s*=\s*([^\s,]+)/i);
  return m?.[1] ?? null;
}

/**
 * Probe the MCP endpoint; on 401, follow WWW-Authenticate resource_metadata.
 */
export async function discoverProtectedResourceFromChallenge(
  mcpUrl: string,
): Promise<ProtectedResourceMetadata | null> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/event-stream',
      },
      redirect: 'manual',
    });
    if (res.status !== 401 && res.status !== 403) {
      // Some servers return 401 only on POST; try a minimal JSON-RPC initialize
      if (res.ok) return null;
    }
    const www = res.headers.get('www-authenticate');
    const metaUrl = parseResourceMetadataFromWwwAuthenticate(www);
    if (!metaUrl) return null;
    const raw = await fetchJson(metaUrl);
    return parseProtectedResource(raw, mcpUrl);
  } catch (err) {
    log.debug('MCP challenge discovery failed', { mcpUrl, err: String(err) });
    return null;
  }
}

export async function discoverProtectedResource(mcpUrl: string): Promise<ProtectedResourceMetadata> {
  const fromChallenge = await discoverProtectedResourceFromChallenge(mcpUrl);
  if (fromChallenge) return fromChallenge;

  const candidates = protectedResourceMetadataUrls(mcpUrl);
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const raw = await fetchJson(url);
      return parseProtectedResource(raw, mcpUrl);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(
    `Could not discover OAuth protected resource metadata for ${mcpUrl}. Tried:\n${errors.join('\n')}`,
  );
}

function mapAsMetadata(raw: Record<string, unknown>, fallbackIssuer: string): AuthorizationServerMetadata {
  const authorization_endpoint = raw.authorization_endpoint;
  const token_endpoint = raw.token_endpoint;
  if (typeof authorization_endpoint !== 'string' || typeof token_endpoint !== 'string') {
    throw new Error('missing authorization_endpoint or token_endpoint');
  }
  return {
    issuer: typeof raw.issuer === 'string' ? raw.issuer : stripTrailingSlash(fallbackIssuer),
    authorization_endpoint,
    token_endpoint,
    registration_endpoint:
      typeof raw.registration_endpoint === 'string' ? raw.registration_endpoint : undefined,
    scopes_supported: Array.isArray(raw.scopes_supported)
      ? raw.scopes_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    code_challenge_methods_supported: Array.isArray(raw.code_challenge_methods_supported)
      ? raw.code_challenge_methods_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    grant_types_supported: Array.isArray(raw.grant_types_supported)
      ? raw.grant_types_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    client_id_metadata_document_supported:
      raw.client_id_metadata_document_supported === true ? true : undefined,
    raw,
  };
}

export async function discoverAuthorizationServer(issuer: string): Promise<AuthorizationServerMetadata> {
  const candidates = authorizationServerMetadataUrls(issuer);
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const raw = await fetchJson(url);
      return mapAsMetadata(raw, issuer);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Zoho Accounts often exposes OAuth via /oauth/v2 without RFC 8414 at the
  // issuer root — synthesize from known Zoho endpoints when issuer matches.
  if (/^https:\/\/accounts\.zoho\./i.test(issuer)) {
    const base = stripTrailingSlash(issuer);
    log.info('Using Zoho Accounts synthesized AS metadata', { issuer: base });
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/v2/auth`,
      token_endpoint: `${base}/oauth/v2/token`,
      scopes_supported: undefined,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      raw: { synthesized: true },
    };
  }

  throw new Error(
    `Could not discover authorization server metadata for ${issuer}. Tried:\n${errors.join('\n')}`,
  );
}

function resolveScopes(
  resource: ProtectedResourceMetadata,
  as: AuthorizationServerMetadata,
  requested?: string[],
): string[] {
  if (requested && requested.length > 0) return requested;
  if (resource.scopes_supported?.length) return resource.scopes_supported;
  if (as.scopes_supported?.length) {
    const scopes = [...as.scopes_supported];
    if (!scopes.includes('offline_access') && scopes.includes('openid')) {
      return scopes;
    }
    return scopes.slice(0, 12);
  }
  return [];
}

/**
 * Zoho-hosted fallback when PRM well-known is missing: point at accounts.zoho.*
 * for the matching DC. Real MCP URLs usually expose PRM; this covers gaps.
 */
async function zohoHostedFallbackDiscovery(
  canonicalMcpUrl: string,
  requestedScopes?: string[],
): Promise<DiscoveryResult> {
  const issuer = zohoAccountsIssuerFromMcpUrl(canonicalMcpUrl);
  const authorizationServer = await discoverAuthorizationServer(issuer);
  const resource: ProtectedResourceMetadata = {
    resource: canonicalMcpUrl,
    authorization_servers: [authorizationServer.issuer],
    scopes_supported: requestedScopes,
    bearer_methods_supported: ['header'],
    raw: { synthesized: true, zoho_hosted_fallback: true },
  };
  const envScopes =
    process.env.GATEWAY_OAUTH_ZOHO_SCOPES?.trim()
      ?.split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const scopes = resolveScopes(resource, authorizationServer, requestedScopes?.length ? requestedScopes : envScopes);

  log.warn('Zoho-hosted MCP: using accounts.zoho fallback discovery (PRM not found)', {
    mcpUrl: canonicalMcpUrl,
    issuer: authorizationServer.issuer,
  });

  return {
    mcpUrl: canonicalMcpUrl,
    canonicalMcpUrl,
    resource,
    authorizationServer,
    hostPattern: hostPatternFromUrl(canonicalMcpUrl),
    scopes,
    zohoHosted: true,
  };
}

/**
 * Full discovery from a remote MCP URL (including Zoho-hosted).
 */
export async function discoverFromMcpUrl(
  mcpUrl: string,
  options?: { scopes?: string[]; authorizationServer?: string },
): Promise<DiscoveryResult> {
  const zohoHosted = isZohoHostedMcpUrl(mcpUrl);
  const canonicalMcpUrl = zohoHosted ? normalizeZohoMcpUrl(mcpUrl) : mcpUrl;

  let resource: ProtectedResourceMetadata;
  try {
    resource = await discoverProtectedResource(canonicalMcpUrl);
  } catch (err) {
    if (zohoHosted) {
      return zohoHostedFallbackDiscovery(canonicalMcpUrl, options?.scopes);
    }
    throw err;
  }

  // Prefer PRM-declared resource URL as canonical when Zoho rewrote ?key=
  let effectiveMcpUrl = canonicalMcpUrl;
  if (zohoHosted && resource.resource && /^https?:\/\//i.test(resource.resource)) {
    effectiveMcpUrl = resource.resource;
  }

  const issuer =
    options?.authorizationServer ??
    resource.authorization_servers[0];
  if (!issuer) {
    throw new Error(`No authorization_servers listed for resource ${canonicalMcpUrl}`);
  }
  if (
    options?.authorizationServer &&
    !resource.authorization_servers.includes(options.authorizationServer)
  ) {
    log.warn('Requested authorization server not in resource metadata; proceeding anyway', {
      requested: options.authorizationServer,
      listed: resource.authorization_servers,
    });
  }

  const authorizationServer = await discoverAuthorizationServer(issuer);
  const scopes = resolveScopes(resource, authorizationServer, options?.scopes);

  return {
    mcpUrl: canonicalMcpUrl,
    canonicalMcpUrl: effectiveMcpUrl,
    resource,
    authorizationServer,
    hostPattern: hostPatternFromUrl(effectiveMcpUrl),
    scopes,
    zohoHosted,
  };
}

/**
 * Discover AS metadata when the caller already knows the issuer
 * (pre-registration path without an MCP URL).
 */
export async function discoverFromIssuer(issuer: string): Promise<AuthorizationServerMetadata> {
  return discoverAuthorizationServer(issuer);
}

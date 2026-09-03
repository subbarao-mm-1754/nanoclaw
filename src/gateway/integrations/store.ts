import { generateId } from '../auth.js';
import { getGatewayDb } from '../db/connection.js';
import type { ClientRegistration } from './registration.js';
import type {
  OAuthConnection,
  OAuthConnectionStatus,
  OAuthRegistration,
  OAuthState,
  RegistrationMethod,
  TokenSet,
} from './types.js';

function now(): string {
  return new Date().toISOString();
}

function mapRegistration(row: Record<string, unknown>): OAuthRegistration {
  return {
    id: row.id as string,
    issuer: row.issuer as string,
    resource: (row.resource as string | null) ?? null,
    registration_method: row.registration_method as RegistrationMethod,
    client_id: row.client_id as string,
    client_secret: (row.client_secret as string | null) ?? null,
    authorization_endpoint: row.authorization_endpoint as string,
    token_endpoint: row.token_endpoint as string,
    registration_endpoint: (row.registration_endpoint as string | null) ?? null,
    redirect_uris_json: (row.redirect_uris_json as string) || '[]',
    scopes_supported_json: (row.scopes_supported_json as string) || '[]',
    token_endpoint_auth_method: (row.token_endpoint_auth_method as string) || 'none',
    host_pattern: row.host_pattern as string,
    header_name: (row.header_name as string) || 'Authorization',
    value_format: (row.value_format as string) || 'Bearer {value}',
    mcp_url: (row.mcp_url as string | null) ?? null,
    metadata_json: (row.metadata_json as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapConnection(row: Record<string, unknown>): OAuthConnection {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    provider: row.provider as string,
    status: row.status as OAuthConnectionStatus,
    registration_id: (row.registration_id as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    mcp_url: (row.mcp_url as string | null) ?? null,
    mcp_server_name: (row.mcp_server_name as string | null) ?? null,
    scopes: (row.scopes as string | null) ?? null,
    refresh_token: (row.refresh_token as string | null) ?? null,
    access_token: (row.access_token as string | null) ?? null,
    access_token_expires_at: (row.access_token_expires_at as string | null) ?? null,
    token_type: (row.token_type as string) || 'Bearer',
    onecli_secret_id: (row.onecli_secret_id as string | null) ?? null,
    account_label: (row.account_label as string | null) ?? null,
    metadata_json: (row.metadata_json as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function registrationToClient(reg: OAuthRegistration): ClientRegistration {
  let redirectUris: string[] = [];
  let scopes: string[] = [];
  try {
    redirectUris = JSON.parse(reg.redirect_uris_json) as string[];
  } catch {
    redirectUris = [];
  }
  try {
    scopes = JSON.parse(reg.scopes_supported_json) as string[];
  } catch {
    scopes = [];
  }
  return {
    issuer: reg.issuer,
    client_id: reg.client_id,
    client_secret: reg.client_secret,
    registration_method: reg.registration_method,
    authorization_endpoint: reg.authorization_endpoint,
    token_endpoint: reg.token_endpoint,
    registration_endpoint: reg.registration_endpoint,
    redirect_uris: redirectUris,
    scopes_supported: scopes,
    token_endpoint_auth_method: reg.token_endpoint_auth_method,
  };
}

export function getRegistrationByIssuer(issuer: string): OAuthRegistration | null {
  const normalized = issuer.replace(/\/$/, '');
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_oauth_registrations
       WHERE issuer = ? OR issuer = ?`,
    )
    .get(issuer, normalized) as Record<string, unknown> | undefined;
  return row ? mapRegistration(row) : null;
}

export function getRegistration(id: string): OAuthRegistration | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_oauth_registrations WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRegistration(row) : null;
}

export function listRegistrations(): OAuthRegistration[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM gateway_oauth_registrations ORDER BY issuer')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRegistration);
}

export function upsertRegistration(input: {
  issuer: string;
  resource?: string | null;
  registration_method: RegistrationMethod;
  client_id: string;
  client_secret?: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string | null;
  redirect_uris: string[];
  scopes_supported?: string[];
  token_endpoint_auth_method?: string;
  host_pattern: string;
  header_name?: string;
  value_format?: string;
  mcp_url?: string | null;
  metadata?: Record<string, unknown> | null;
}): OAuthRegistration {
  const existing = getRegistrationByIssuer(input.issuer);
  const ts = now();
  const redirectJson = JSON.stringify(input.redirect_uris);
  const scopesJson = JSON.stringify(input.scopes_supported ?? []);
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  if (existing) {
    getGatewayDb()
      .prepare(
        `UPDATE gateway_oauth_registrations SET
           resource = COALESCE(?, resource),
           registration_method = ?,
           client_id = ?,
           client_secret = ?,
           authorization_endpoint = ?,
           token_endpoint = ?,
           registration_endpoint = ?,
           redirect_uris_json = ?,
           scopes_supported_json = ?,
           token_endpoint_auth_method = ?,
           host_pattern = ?,
           header_name = ?,
           value_format = ?,
           mcp_url = COALESCE(?, mcp_url),
           metadata_json = COALESCE(?, metadata_json),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.resource ?? null,
        input.registration_method,
        input.client_id,
        input.client_secret ?? null,
        input.authorization_endpoint,
        input.token_endpoint,
        input.registration_endpoint ?? null,
        redirectJson,
        scopesJson,
        input.token_endpoint_auth_method ?? 'none',
        input.host_pattern,
        input.header_name ?? 'Authorization',
        input.value_format ?? 'Bearer {value}',
        input.mcp_url ?? null,
        metadataJson,
        ts,
        existing.id,
      );
    return getRegistration(existing.id)!;
  }

  const id = generateId('oreg');
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_oauth_registrations (
         id, issuer, resource, registration_method, client_id, client_secret,
         authorization_endpoint, token_endpoint, registration_endpoint,
         redirect_uris_json, scopes_supported_json, token_endpoint_auth_method,
         host_pattern, header_name, value_format, mcp_url, metadata_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.issuer,
      input.resource ?? null,
      input.registration_method,
      input.client_id,
      input.client_secret ?? null,
      input.authorization_endpoint,
      input.token_endpoint,
      input.registration_endpoint ?? null,
      redirectJson,
      scopesJson,
      input.token_endpoint_auth_method ?? 'none',
      input.host_pattern,
      input.header_name ?? 'Authorization',
      input.value_format ?? 'Bearer {value}',
      input.mcp_url ?? null,
      metadataJson,
      ts,
      ts,
    );
  return getRegistration(id)!;
}

export function listConnectionsForUser(userId: string): OAuthConnection[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_oauth_connections
       WHERE user_id = ?
       ORDER BY provider`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(mapConnection);
}

export function getConnection(id: string): OAuthConnection | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_oauth_connections WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapConnection(row) : null;
}

export function getConnectionForUserProvider(userId: string, provider: string): OAuthConnection | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_oauth_connections
       WHERE user_id = ? AND provider = ?`,
    )
    .get(userId, provider) as Record<string, unknown> | undefined;
  return row ? mapConnection(row) : null;
}

export function upsertPendingConnection(
  userId: string,
  provider: string,
  extras?: {
    registrationId?: string | null;
    resource?: string | null;
    mcpUrl?: string | null;
    mcpServerName?: string | null;
  },
): OAuthConnection {
  const existing = getConnectionForUserProvider(userId, provider);
  const ts = now();
  if (existing) {
    getGatewayDb()
      .prepare(
        `UPDATE gateway_oauth_connections
         SET status = 'pending',
             last_error = NULL,
             registration_id = COALESCE(?, registration_id),
             resource = COALESCE(?, resource),
             mcp_url = COALESCE(?, mcp_url),
             mcp_server_name = COALESCE(?, mcp_server_name),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        extras?.registrationId ?? null,
        extras?.resource ?? null,
        extras?.mcpUrl ?? null,
        extras?.mcpServerName ?? null,
        ts,
        existing.id,
      );
    return getConnection(existing.id)!;
  }

  const id = generateId('oauth');
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_oauth_connections (
         id, user_id, provider, status, token_type,
         registration_id, resource, mcp_url, mcp_server_name,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', 'Bearer', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      provider,
      extras?.registrationId ?? null,
      extras?.resource ?? null,
      extras?.mcpUrl ?? null,
      extras?.mcpServerName ?? null,
      ts,
      ts,
    );
  return getConnection(id)!;
}

/** Update MCP URL / name on a connected row without resetting status to pending. */
export function patchConnectionMcpMeta(
  connectionId: string,
  input: {
    mcpUrl?: string | null;
    mcpServerName?: string | null;
    registrationId?: string | null;
    resource?: string | null;
  },
): OAuthConnection {
  const existing = getConnection(connectionId);
  if (!existing) throw new Error(`OAuth connection not found: ${connectionId}`);
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections SET
         mcp_url = COALESCE(?, mcp_url),
         mcp_server_name = COALESCE(?, mcp_server_name),
         registration_id = COALESCE(?, registration_id),
         resource = COALESCE(?, resource),
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.mcpUrl !== undefined ? input.mcpUrl : null,
      input.mcpServerName !== undefined ? input.mcpServerName : null,
      input.registrationId !== undefined ? input.registrationId : null,
      input.resource !== undefined ? input.resource : null,
      ts,
      connectionId,
    );
  return getConnection(connectionId)!;
}

export function applyTokenSet(
  connectionId: string,
  tokens: TokenSet,
  options?: { keepRefreshIfMissing?: boolean },
): OAuthConnection {
  const existing = getConnection(connectionId);
  if (!existing) throw new Error(`OAuth connection not found: ${connectionId}`);

  const ts = now();
  const refreshToken =
    tokens.refresh_token ??
    (options?.keepRefreshIfMissing === false ? null : existing.refresh_token);
  const expiresAt =
    typeof tokens.expires_in === 'number'
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : existing.access_token_expires_at;
  const scopes = tokens.scope ?? existing.scopes;
  const accountLabel = tokens.account_label ?? existing.account_label;
  // Merge token metadata into existing JSON so channel fields (chat_ids, …)
  // survive access-token refreshes that only carry api_domain.
  let metadataJson = existing.metadata_json;
  if (tokens.metadata) {
    let existingMeta: Record<string, unknown> = {};
    if (existing.metadata_json) {
      try {
        existingMeta = JSON.parse(existing.metadata_json) as Record<string, unknown>;
      } catch {
        existingMeta = {};
      }
    }
    metadataJson = JSON.stringify({ ...existingMeta, ...tokens.metadata });
  }

  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections SET
         status = 'connected',
         refresh_token = ?,
         access_token = ?,
         access_token_expires_at = ?,
         token_type = ?,
         scopes = ?,
         account_label = ?,
         metadata_json = ?,
         last_error = NULL,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      refreshToken,
      tokens.access_token,
      expiresAt,
      tokens.token_type || existing.token_type || 'Bearer',
      scopes,
      accountLabel,
      metadataJson,
      ts,
      connectionId,
    );

  return getConnection(connectionId)!;
}

/** Deep-merge keys into connection.metadata_json (preserves other fields). */
export function mergeConnectionMetadata(
  connectionId: string,
  patch: Record<string, unknown>,
): OAuthConnection {
  const existing = getConnection(connectionId);
  if (!existing) throw new Error(`OAuth connection not found: ${connectionId}`);
  let meta: Record<string, unknown> = {};
  if (existing.metadata_json) {
    try {
      meta = JSON.parse(existing.metadata_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  const ts = now();
  const metadataJson = JSON.stringify({ ...meta, ...patch });
  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections
       SET metadata_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(metadataJson, ts, connectionId);
  return getConnection(connectionId)!;
}

export function listConnectionsByProvider(provider: string): OAuthConnection[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_oauth_connections
       WHERE provider = ? AND status = 'connected'
       ORDER BY updated_at DESC`,
    )
    .all(provider) as Array<Record<string, unknown>>;
  return rows.map(mapConnection);
}

export function setOnecliSecretId(connectionId: string, secretId: string | null): void {
  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections
       SET onecli_secret_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(secretId, now(), connectionId);
}

export function setConnectionError(connectionId: string, error: string): void {
  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections
       SET status = 'error', last_error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(error, now(), connectionId);
}

export function revokeConnection(connectionId: string): void {
  getGatewayDb()
    .prepare(
      `UPDATE gateway_oauth_connections
       SET status = 'revoked',
           refresh_token = NULL,
           access_token = NULL,
           access_token_expires_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(now(), connectionId);
}

export function createOAuthState(input: {
  state: string;
  userId: string;
  provider: string;
  codeVerifier: string | null;
  workspaceId: string | null;
  buildJobId?: string | null;
  registrationId?: string | null;
  resource?: string | null;
  mcpUrl?: string | null;
  mcpServerName?: string | null;
  ttlMs?: number;
}): OAuthState {
  const ts = now();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 15 * 60 * 1000)).toISOString();
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_oauth_states (
         state, user_id, provider, code_verifier, workspace_id, build_job_id,
         registration_id, resource, mcp_url, mcp_server_name,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.state,
      input.userId,
      input.provider,
      input.codeVerifier,
      input.workspaceId,
      input.buildJobId ?? null,
      input.registrationId ?? null,
      input.resource ?? null,
      input.mcpUrl ?? null,
      input.mcpServerName ?? null,
      ts,
      expiresAt,
    );
  return {
    state: input.state,
    user_id: input.userId,
    provider: input.provider,
    code_verifier: input.codeVerifier,
    workspace_id: input.workspaceId,
    build_job_id: input.buildJobId ?? null,
    registration_id: input.registrationId ?? null,
    resource: input.resource ?? null,
    mcp_url: input.mcpUrl ?? null,
    mcp_server_name: input.mcpServerName ?? null,
    created_at: ts,
    expires_at: expiresAt,
  };
}

export function consumeOAuthState(state: string): OAuthState | null {
  const db = getGatewayDb();
  const row = db
    .prepare('SELECT * FROM gateway_oauth_states WHERE state = ?')
    .get(state) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM gateway_oauth_states WHERE state = ?').run(state);
  const expiresAt = row.expires_at as string;
  if (new Date(expiresAt).getTime() < Date.now()) return null;
  return {
    state: row.state as string,
    user_id: row.user_id as string,
    provider: row.provider as string,
    code_verifier: (row.code_verifier as string | null) ?? null,
    workspace_id: (row.workspace_id as string | null) ?? null,
    build_job_id: (row.build_job_id as string | null) ?? null,
    registration_id: (row.registration_id as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    mcp_url: (row.mcp_url as string | null) ?? null,
    mcp_server_name: (row.mcp_server_name as string | null) ?? null,
    created_at: row.created_at as string,
    expires_at: expiresAt,
  };
}

export function bindWorkspaceIntegration(workspaceId: string, connectionId: string): void {
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_workspace_integrations (workspace_id, connection_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, connection_id) DO NOTHING`,
    )
    .run(workspaceId, connectionId, now());
}

export function unbindWorkspaceIntegration(workspaceId: string, connectionId: string): void {
  getGatewayDb()
    .prepare(
      `DELETE FROM gateway_workspace_integrations
       WHERE workspace_id = ? AND connection_id = ?`,
    )
    .run(workspaceId, connectionId);
}

export function listConnectionsForWorkspace(workspaceId: string): OAuthConnection[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT c.*
       FROM gateway_oauth_connections c
       INNER JOIN gateway_workspace_integrations w
         ON w.connection_id = c.id
       WHERE w.workspace_id = ?
       ORDER BY c.provider`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapConnection);
}

export function listWorkspaceIdsForConnection(connectionId: string): string[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT workspace_id FROM gateway_workspace_integrations WHERE connection_id = ?`,
    )
    .all(connectionId) as Array<{ workspace_id: string }>;
  return rows.map((r) => r.workspace_id);
}

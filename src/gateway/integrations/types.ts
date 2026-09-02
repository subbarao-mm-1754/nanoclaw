export type OAuthConnectionStatus = 'pending' | 'connected' | 'revoked' | 'error';
export type RegistrationMethod = 'dcr' | 'pre_registered';

export interface OAuthRegistration {
  id: string;
  issuer: string;
  resource: string | null;
  registration_method: RegistrationMethod;
  client_id: string;
  client_secret: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  redirect_uris_json: string;
  scopes_supported_json: string;
  token_endpoint_auth_method: string;
  host_pattern: string;
  header_name: string;
  value_format: string;
  mcp_url: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface OAuthConnection {
  id: string;
  user_id: string;
  /** Stable key: issuer host, or mcp server name, or legacy provider id. */
  provider: string;
  status: OAuthConnectionStatus;
  registration_id: string | null;
  resource: string | null;
  mcp_url: string | null;
  mcp_server_name: string | null;
  scopes: string | null;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  token_type: string;
  onecli_secret_id: string | null;
  account_label: string | null;
  metadata_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Public view — never includes raw tokens or client secrets. */
export interface OAuthConnectionPublic {
  id: string;
  provider: string;
  status: OAuthConnectionStatus;
  registration_id: string | null;
  resource: string | null;
  mcp_url: string | null;
  mcp_server_name: string | null;
  scopes: string | null;
  account_label: string | null;
  onecli_secret_id: string | null;
  access_token_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OAuthRegistrationPublic {
  id: string;
  issuer: string;
  resource: string | null;
  registration_method: RegistrationMethod;
  client_id: string;
  has_client_secret: boolean;
  host_pattern: string;
  mcp_url: string | null;
  scopes_supported: string[];
  created_at: string;
  updated_at: string;
}

export interface OAuthState {
  state: string;
  user_id: string;
  provider: string;
  code_verifier: string | null;
  workspace_id: string | null;
  build_job_id: string | null;
  registration_id: string | null;
  resource: string | null;
  mcp_url: string | null;
  mcp_server_name: string | null;
  created_at: string;
  expires_at: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  account_label?: string;
  metadata?: Record<string, unknown>;
}

/** Legacy hardcoded provider (Zoho etc.) — still supported alongside discovery. */
export interface OAuthProviderConfig {
  id: string;
  displayName: string;
  hostPattern: string;
  headerName?: string;
  valueFormat?: string;
  scopes: string[];
  buildAuthorizeUrl(input: {
    redirectUri: string;
    state: string;
    codeVerifier: string | null;
    scopes: string[];
  }): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
}

export function toPublicConnection(row: OAuthConnection): OAuthConnectionPublic {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    registration_id: row.registration_id,
    resource: row.resource,
    mcp_url: row.mcp_url,
    mcp_server_name: row.mcp_server_name,
    scopes: row.scopes,
    account_label: row.account_label,
    onecli_secret_id: row.onecli_secret_id,
    access_token_expires_at: row.access_token_expires_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toPublicRegistration(row: OAuthRegistration): OAuthRegistrationPublic {
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes_supported_json) as string[];
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    issuer: row.issuer,
    resource: row.resource,
    registration_method: row.registration_method,
    client_id: row.client_id,
    has_client_secret: Boolean(row.client_secret),
    host_pattern: row.host_pattern,
    mcp_url: row.mcp_url,
    scopes_supported: scopes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stable provider key for a discovered MCP / issuer pair. */
export function providerKeyFromDiscovery(input: {
  mcpServerName?: string | null;
  mcpUrl?: string | null;
  issuer: string;
}): string {
  if (input.mcpServerName?.trim()) return input.mcpServerName.trim().toLowerCase();
  if (input.mcpUrl) {
    try {
      return `mcp:${new URL(input.mcpUrl).hostname}`;
    } catch {
      /* fall through */
    }
  }
  try {
    return `as:${new URL(input.issuer).hostname}`;
  } catch {
    return `as:${input.issuer}`;
  }
}

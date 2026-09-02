import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import { registerWorkspace } from '../store/workspaces.js';
import {
  applyTokenSet,
  bindWorkspaceIntegration,
  createOAuthState,
  consumeOAuthState,
  getConnection,
  getRegistrationByIssuer,
  listConnectionsForWorkspace,
  upsertPendingConnection,
  upsertRegistration,
} from './store.js';
import { toPublicConnection } from './types.js';
import { registerOAuthProvider } from './providers/index.js';
import type { OAuthProviderConfig } from './types.js';
import {
  authorizationServerMetadataUrls,
  parseResourceMetadataFromWwwAuthenticate,
  protectedResourceMetadataUrls,
} from './discovery.js';
import {
  isZohoHostedMcpUrl,
  normalizeZohoMcpUrl,
  zohoAccountsIssuerFromMcpUrl,
} from './zoho-hosted.js';
import {
  ensureClientRegistration,
  findPreRegistered,
  loadPreRegisteredFromEnv,
} from './registration.js';
import { buildAuthorizeUrl } from './oauth-client.js';
import { newCodeVerifier } from './pkce.js';
import { registrationToClient } from './store.js';
import {
  extractPrimaryRemoteMcpUrl,
  extractRemoteMcpUrls,
  suggestMcpServerName,
} from './mcp-url.js';

vi.mock('./onecli-sync.js', () => ({
  upsertAccessTokenSecret: vi.fn(async () => 'secret-test-1'),
  assignSecretToAgent: vi.fn(async () => undefined),
  findAgentIdByIdentifier: vi.fn(async () => 'agent-1'),
}));

beforeEach(() => {
  initGatewayTestDb();
  delete process.env.GATEWAY_OAUTH_PRE_REG_JSON;
});

afterEach(() => {
  closeGatewayDb();
});

describe('discovery URL helpers', () => {
  it('builds path-aware protected resource metadata URLs', () => {
    const urls = protectedResourceMetadataUrls('https://mcp.example.com/v1/sse');
    expect(urls[0]).toBe('https://mcp.example.com/.well-known/oauth-protected-resource/v1/sse');
    expect(urls).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
  });

  it('builds authorization server metadata URLs including OIDC', () => {
    const urls = authorizationServerMetadataUrls('https://auth.example.com');
    expect(urls).toContain('https://auth.example.com/.well-known/oauth-authorization-server');
    expect(urls).toContain('https://auth.example.com/.well-known/openid-configuration');
  });

  it('parses WWW-Authenticate resource_metadata', () => {
    expect(
      parseResourceMetadataFromWwwAuthenticate(
        'Bearer realm="mcp", resource_metadata="https://ex.com/.well-known/oauth-protected-resource"',
      ),
    ).toBe('https://ex.com/.well-known/oauth-protected-resource');
  });
});

describe('zoho-hosted MCP helpers', () => {
  it('detects Zoho-hosted hosts', () => {
    expect(isZohoHostedMcpUrl('https://abc.zohomcp.eu/mcp/message?key=k')).toBe(true);
    expect(isZohoHostedMcpUrl('https://mcp.zoho.in/x')).toBe(true);
    expect(isZohoHostedMcpUrl('https://mcp.example.com/sse')).toBe(false);
  });

  it('normalizes ?key= URLs to path form', () => {
    expect(normalizeZohoMcpUrl('https://t.zohomcp.eu/mcp/message?key=abc123')).toBe(
      'https://t.zohomcp.eu/mcp/abc123/message',
    );
    expect(normalizeZohoMcpUrl('https://t.zohomcp.eu/mcp/abc123/message')).toBe(
      'https://t.zohomcp.eu/mcp/abc123/message',
    );
  });

  it('maps MCP region to accounts issuer', () => {
    expect(zohoAccountsIssuerFromMcpUrl('https://x.zohomcp.in/mcp/k/message')).toBe(
      'https://accounts.zoho.in',
    );
    expect(zohoAccountsIssuerFromMcpUrl('https://x.zohomcp.eu/mcp/k/message')).toBe(
      'https://accounts.zoho.eu',
    );
  });

  it('includes both query and path forms in PRM candidates', () => {
    const urls = protectedResourceMetadataUrls('https://t.zohomcp.eu/mcp/message?key=abc');
    expect(urls.some((u) => u.includes('/mcp/abc/message'))).toBe(true);
  });

  it('synthesizes Zoho Accounts AS metadata when well-known is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no well-known'));
    const { discoverAuthorizationServer } = await import('./discovery.js');
    const as = await discoverAuthorizationServer('https://accounts.zoho.in');
    expect(as.authorization_endpoint).toBe('https://accounts.zoho.in/oauth/v2/auth');
    expect(as.token_endpoint).toBe('https://accounts.zoho.in/oauth/v2/token');
    fetchMock.mockRestore();
  });
});

describe('registration helpers', () => {
  it('loads pre-registered clients from env JSON', () => {
    process.env.GATEWAY_OAUTH_PRE_REG_JSON = JSON.stringify([
      {
        issuer: 'https://auth.example.com',
        client_id: 'cid',
        client_secret: 'csec',
      },
    ]);
    const list = loadPreRegisteredFromEnv();
    expect(findPreRegistered('https://auth.example.com', list)?.client_id).toBe('cid');
  });

  it('uses DCR when registration_endpoint is present', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: 'dcr-client',
          token_endpoint_auth_method: 'none',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const reg = await ensureClientRegistration({
      as: {
        issuer: 'https://as.example.com',
        authorization_endpoint: 'https://as.example.com/auth',
        token_endpoint: 'https://as.example.com/token',
        registration_endpoint: 'https://as.example.com/register',
        code_challenge_methods_supported: ['S256'],
        raw: {},
      },
      redirectUri: 'http://127.0.0.1:8090/v1/integrations/oauth/callback',
    });

    expect(reg.registration_method).toBe('dcr');
    expect(reg.client_id).toBe('dcr-client');
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('prefers pre-registered credentials over DCR', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const reg = await ensureClientRegistration({
      as: {
        issuer: 'https://as.example.com',
        authorization_endpoint: 'https://as.example.com/auth',
        token_endpoint: 'https://as.example.com/token',
        registration_endpoint: 'https://as.example.com/register',
        raw: {},
      },
      redirectUri: 'http://127.0.0.1:8090/callback',
      preRegistered: {
        issuer: 'https://as.example.com',
        client_id: 'pre-id',
        client_secret: 'pre-secret',
      },
    });
    expect(reg.registration_method).toBe('pre_registered');
    expect(reg.client_id).toBe('pre-id');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe('gateway oauth store', () => {
  it('stores registrations and connections', () => {
    const user = createUser({
      email: 'oauth@example.com',
      password: 'password123',
      display_name: 'OAuth User',
    });
    registerWorkspace({
      workspace_id: 'ws-oauth-1',
      agent_group_id: 'ag-oauth-1',
      name: 'OAuth Agent',
      owner_user_id: user.id,
    });

    const registration = upsertRegistration({
      issuer: 'https://as.example.com',
      registration_method: 'dcr',
      client_id: 'cid',
      authorization_endpoint: 'https://as.example.com/auth',
      token_endpoint: 'https://as.example.com/token',
      redirect_uris: ['http://127.0.0.1:8090/callback'],
      host_pattern: 'mcp.example.com',
      mcp_url: 'https://mcp.example.com/sse',
    });
    expect(getRegistrationByIssuer('https://as.example.com')?.id).toBe(registration.id);

    const pending = upsertPendingConnection(user.id, 'mcp:mcp.example.com', {
      registrationId: registration.id,
      mcpUrl: 'https://mcp.example.com/sse',
      mcpServerName: 'github',
    });
    const connected = applyTokenSet(pending.id, {
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
    });

    expect(connected.registration_id).toBe(registration.id);
    expect(connected.mcp_url).toBe('https://mcp.example.com/sse');

    bindWorkspaceIntegration('ws-oauth-1', connected.id);
    expect(listConnectionsForWorkspace('ws-oauth-1')).toHaveLength(1);

    const pub = toPublicConnection(connected);
    expect((pub as { refresh_token?: string }).refresh_token).toBeUndefined();

    const authorize = buildAuthorizeUrl({
      registration: registrationToClient(registration),
      redirectUri: 'http://127.0.0.1:8090/callback',
      state: 'st',
      codeVerifier: newCodeVerifier(),
      scopes: ['openid'],
      resource: 'https://mcp.example.com/sse',
    });
    expect(authorize).toContain('code_challenge=');
    expect(authorize).toContain('resource=');
  });

  it('reuses an existing connected OAuth connection for the same user', async () => {
    const { findReusableUserConnection, startOAuthConnect } = await import('./broker.js');
    const { createBuildJob, getBuildJob } = await import('../store/builds.js');

    const fakeProvider: OAuthProviderConfig = {
      id: 'reuseprovider',
      displayName: 'Reuse',
      hostPattern: 'api.reuse.example.com',
      scopes: ['read'],
      buildAuthorizeUrl: () => 'https://example.com/auth',
      exchangeCode: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 120 }),
      refresh: async () => ({ access_token: 'a2', expires_in: 120 }),
    };
    registerOAuthProvider(fakeProvider);

    const user = createUser({
      email: 'reuse@example.com',
      password: 'password123',
      display_name: 'Reuse User',
    });
    const pending = upsertPendingConnection(user.id, 'reuseprovider', {
      mcpUrl: 'https://mcp.reuse.example.com/sse',
      mcpServerName: 'reuseprovider',
    });
    applyTokenSet(pending.id, {
      access_token: 'atk',
      refresh_token: 'rtk',
      expires_in: 3600,
    });

    const found = findReusableUserConnection(
      user.id,
      'reuseprovider',
      'https://mcp.reuse.example.com/sse?v=2',
    );
    expect(found?.id).toBe(pending.id);

    const job = createBuildJob({
      id: 'job-reuse-mcp',
      user_id: user.id,
      builder_workspace_id: 'ws-b',
      builder_agent_group_id: 'ag-b',
      builder_session_id: 'sess-b',
    });

    const result = await startOAuthConnect({
      userId: user.id,
      provider: 'reuseprovider',
      buildJobId: job.id,
    });
    expect(result.reused).toBe(true);
    expect(result.authorize_url).toBeNull();
    expect(result.connection_id).toBe(pending.id);

    const updatedJob = getBuildJob(job.id)!;
    expect(updatedJob.pending_connection_id).toBe(pending.id);
    expect(getConnection(pending.id)!.status).toBe('connected');
  });

  it('consumes oauth state once with registration fields', () => {
    const user = createUser({
      email: 'state@example.com',
      password: 'password123',
      display_name: 'State User',
    });
    createOAuthState({
      state: 'state-1',
      userId: user.id,
      provider: 'mcp:x',
      codeVerifier: 'verifier',
      workspaceId: null,
      registrationId: 'oreg-1',
      mcpUrl: 'https://mcp.example.com',
    });
    const first = consumeOAuthState('state-1');
    expect(first?.registration_id).toBe('oreg-1');
    expect(consumeOAuthState('state-1')).toBeNull();
  });
});

describe('gateway oauth broker callback', () => {
  it('exchanges code for legacy provider and syncs OneCLI', async () => {
    const fakeProvider: OAuthProviderConfig = {
      id: 'testprovider',
      displayName: 'Test',
      hostPattern: 'api.example.com',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
      scopes: ['read'],
      buildAuthorizeUrl: () => 'https://example.com/auth',
      exchangeCode: async () => ({
        access_token: 'atk',
        refresh_token: 'rtk',
        expires_in: 120,
      }),
      refresh: async () => ({
        access_token: 'atk2',
        expires_in: 120,
      }),
    };
    registerOAuthProvider(fakeProvider);

    const user = createUser({
      email: 'broker@example.com',
      password: 'password123',
      display_name: 'Broker User',
    });
    const connection = upsertPendingConnection(user.id, 'testprovider');
    createOAuthState({
      state: 'broker-state',
      userId: user.id,
      provider: 'testprovider',
      codeVerifier: 'v',
      workspaceId: null,
    });

    const { handleOAuthCallback } = await import('./broker.js');
    const { upsertAccessTokenSecret } = await import('./onecli-sync.js');

    const result = await handleOAuthCallback({ code: 'auth-code', state: 'broker-state' });
    expect(result.connection.status).toBe('connected');

    const stored = getConnection(connection.id)!;
    expect(stored.refresh_token).toBe('rtk');
    expect(stored.onecli_secret_id).toBe('secret-test-1');
    expect(upsertAccessTokenSecret).toHaveBeenCalled();
  });
});

describe('mcp-url extract', () => {
  it('extracts Zoho-hosted MCP URLs from chat text', () => {
    const text =
      'Use https://mail-mcp.zohomcp.com/mcp/message?key=abc123 for tools.';
    expect(extractPrimaryRemoteMcpUrl(text)).toContain('zohomcp.com');
    expect(suggestMcpServerName(extractPrimaryRemoteMcpUrl(text)!)).toBe('zoho-hosted');
  });

  it('parses /mcp connect <url>', () => {
    const urls = extractRemoteMcpUrls('/mcp connect https://example.com/v1/mcp');
    expect(urls[0]).toContain('example.com/v1/mcp');
  });
});

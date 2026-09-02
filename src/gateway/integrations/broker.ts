/**
 * Gateway OAuth broker — discovery + DCR / pre-registration + OneCLI sync.
 *
 * Connect paths:
 *   A) Remote MCP URL → discover PRM/AS → DCR or pre-reg → OAuth → OneCLI
 *   B) Legacy named provider (e.g. zoho) → hardcoded provider module
 *   C) Explicit pre-register API → store client_id/secret for an issuer
 *
 * Containers never receive refresh tokens. Access tokens are synced into
 * OneCLI and injected on matching host patterns (MCP hostname or API host).
 */
import { randomBytes } from 'crypto';

import { GATEWAY_PUBLIC_URL } from '../../config.js';
import { log } from '../../log.js';
import { getWorkspace, updateWorkspaceMetadata } from '../store/workspaces.js';
import { assertAgentOwner } from '../store/agent-files.js';
import { defaultContainerConfig } from '../store/agent-files.js';
import type { ContainerConfigSnapshot, McpServerConfig } from '../../container-config.js';
import { assignSecretToAgent, upsertAccessTokenSecret } from './onecli-sync.js';
import { discoverFromIssuer, discoverFromMcpUrl } from './discovery.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './oauth-client.js';
import { newCodeVerifier } from './pkce.js';
import { getOAuthProvider, listOAuthProviders } from './providers/index.js';
import {
  zohoEnvPreRegistered,
} from './zoho-hosted.js';
import {
  ensureClientRegistration,
  findPreRegistered,
  loadPreRegisteredFromEnv,
  type PreRegisteredClient,
} from './registration.js';
import {
  applyTokenSet,
  bindWorkspaceIntegration,
  consumeOAuthState,
  createOAuthState,
  getConnection,
  getConnectionForUserProvider,
  getRegistration,
  getRegistrationByIssuer,
  listConnectionsForUser,
  listConnectionsForWorkspace,
  listRegistrations,
  registrationToClient,
  setConnectionError,
  setOnecliSecretId,
  unbindWorkspaceIntegration,
  upsertPendingConnection,
  upsertRegistration,
} from './store.js';
import {
  providerKeyFromDiscovery,
  toPublicConnection,
  toPublicRegistration,
  type OAuthConnection,
  type OAuthConnectionPublic,
  type OAuthRegistrationPublic,
} from './types.js';

const ACCESS_REFRESH_SKEW_MS = 60_000;
const PLACEHOLDER_BEARER = 'onecli-managed';

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

function oauthRedirectUri(): string {
  return `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/integrations/oauth/callback`;
}

function secretName(connection: OAuthConnection): string {
  return `gateway-${connection.user_id.slice(0, 8)}-${connection.provider}`;
}

function accessTokenFresh(connection: OAuthConnection): boolean {
  if (!connection.access_token || !connection.access_token_expires_at) return false;
  return new Date(connection.access_token_expires_at).getTime() - ACCESS_REFRESH_SKEW_MS > Date.now();
}

export function listProvidersPublic() {
  return listOAuthProviders().map((p) => ({
    id: p.id,
    display_name: p.displayName,
    host_pattern: p.hostPattern,
    scopes: p.scopes,
    kind: 'builtin' as const,
  }));
}

export function listRegistrationsPublic(): OAuthRegistrationPublic[] {
  return listRegistrations().map(toPublicRegistration);
}

export function listUserIntegrations(userId: string): OAuthConnectionPublic[] {
  return listConnectionsForUser(userId).map(toPublicConnection);
}

export function listWorkspaceIntegrations(
  workspaceId: string,
  userId: string,
): OAuthConnectionPublic[] {
  assertAgentOwner(workspaceId, userId);
  return listConnectionsForWorkspace(workspaceId).map(toPublicConnection);
}

/**
 * Persist a pre-registered OAuth client for an issuer (localhost-friendly).
 */
export async function preRegisterClient(input: {
  issuer: string;
  client_id: string;
  client_secret?: string | null;
  mcp_url?: string | null;
  host_pattern?: string | null;
  scopes?: string[];
  authorization_endpoint?: string;
  token_endpoint?: string;
}): Promise<OAuthRegistrationPublic> {
  let as;
  try {
    as = await discoverFromIssuer(input.issuer);
  } catch (err) {
    if (!input.authorization_endpoint || !input.token_endpoint) {
      throw new IntegrationError(
        `Could not discover AS metadata for ${input.issuer} and no endpoints provided: ${
          err instanceof Error ? err.message : String(err)
        }`,
        400,
      );
    }
    as = {
      issuer: input.issuer,
      authorization_endpoint: input.authorization_endpoint,
      token_endpoint: input.token_endpoint,
      scopes_supported: input.scopes,
      raw: {},
    };
  }

  const hostPattern =
    input.host_pattern ??
    (input.mcp_url ? new URL(input.mcp_url).hostname : new URL(input.issuer).hostname);

  const reg = upsertRegistration({
    issuer: as.issuer,
    resource: input.mcp_url ?? null,
    registration_method: 'pre_registered',
    client_id: input.client_id,
    client_secret: input.client_secret ?? null,
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint ?? null,
    redirect_uris: [oauthRedirectUri()],
    scopes_supported: input.scopes ?? as.scopes_supported ?? [],
    token_endpoint_auth_method: input.client_secret ? 'client_secret_post' : 'none',
    host_pattern: hostPattern,
    mcp_url: input.mcp_url ?? null,
  });

  return toPublicRegistration(reg);
}

/**
 * Discover MCP OAuth metadata and ensure a client registration (DCR or pre-reg).
 */
function resolvePreRegisteredForDiscovery(issuer: string): PreRegisteredClient | null {
  const fromEnvList = findPreRegistered(issuer, loadPreRegisteredFromEnv());
  if (fromEnvList) return fromEnvList;

  const zohoPre = zohoEnvPreRegistered(issuer);
  if (!zohoPre) return null;

  const issuerNorm = issuer.replace(/\/$/, '');
  const zohoIssuerNorm = zohoPre.issuer.replace(/\/$/, '');
  if (issuerNorm === zohoIssuerNorm || /accounts\.zoho\./i.test(issuer)) {
    return { ...zohoPre, issuer };
  }
  return null;
}

export async function discoverAndRegister(input: {
  mcpUrl: string;
  scopes?: string[];
  preRegistered?: PreRegisteredClient | null;
}): Promise<OAuthRegistrationPublic> {
  const discovery = await discoverFromMcpUrl(input.mcpUrl, { scopes: input.scopes });
  const existing = getRegistrationByIssuer(discovery.authorizationServer.issuer);
  const preRegistered =
    input.preRegistered ?? resolvePreRegisteredForDiscovery(discovery.authorizationServer.issuer);

  const client = await ensureClientRegistration({
    as: discovery.authorizationServer,
    redirectUri: oauthRedirectUri(),
    existing: existing ? registrationToClient(existing) : null,
    preRegistered,
  });

  const reg = upsertRegistration({
    issuer: client.issuer,
    resource: discovery.resource.resource,
    registration_method: client.registration_method,
    client_id: client.client_id,
    client_secret: client.client_secret,
    authorization_endpoint: client.authorization_endpoint,
    token_endpoint: client.token_endpoint,
    registration_endpoint: client.registration_endpoint,
    redirect_uris: client.redirect_uris,
    scopes_supported: discovery.scopes.length ? discovery.scopes : client.scopes_supported,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    host_pattern: discovery.hostPattern,
    header_name: 'Authorization',
    value_format: 'Bearer {value}',
    mcp_url: discovery.canonicalMcpUrl,
    metadata: {
      scopes: discovery.scopes,
      resource: discovery.resource.resource,
      zoho_hosted: discovery.zohoHosted,
      canonical_mcp_url: discovery.canonicalMcpUrl,
    },
  });

  return toPublicRegistration(reg);
}

export async function startOAuthConnect(input: {
  userId: string;
  /** Legacy builtin provider id (zoho, …). */
  provider?: string;
  /** Remote MCP URL — preferred discovery path. */
  mcpUrl?: string;
  mcpServerName?: string | null;
  workspaceId?: string | null;
  /** When connecting during `/build`, OAuth callback attaches to this job. */
  buildJobId?: string | null;
  scopes?: string[];
}): Promise<{
  authorize_url: string;
  connection_id: string;
  state: string;
  registration_id?: string;
  provider: string;
  mcp_url?: string;
}> {
  if (input.workspaceId) {
    assertAgentOwner(input.workspaceId, input.userId);
  }

  // Path A: remote MCP discovery (incl. Zoho-hosted MCP URLs)
  if (input.mcpUrl) {
    const discovery = await discoverFromMcpUrl(input.mcpUrl, { scopes: input.scopes });
    const existingReg = getRegistrationByIssuer(discovery.authorizationServer.issuer);
    const client = await ensureClientRegistration({
      as: discovery.authorizationServer,
      redirectUri: oauthRedirectUri(),
      existing: existingReg ? registrationToClient(existingReg) : null,
      preRegistered: resolvePreRegisteredForDiscovery(discovery.authorizationServer.issuer),
    });

    const registration = upsertRegistration({
      issuer: client.issuer,
      resource: discovery.resource.resource,
      registration_method: client.registration_method,
      client_id: client.client_id,
      client_secret: client.client_secret,
      authorization_endpoint: client.authorization_endpoint,
      token_endpoint: client.token_endpoint,
      registration_endpoint: client.registration_endpoint,
      redirect_uris: client.redirect_uris,
      scopes_supported: discovery.scopes.length ? discovery.scopes : client.scopes_supported,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      host_pattern: discovery.hostPattern,
      header_name: 'Authorization',
      value_format: 'Bearer {value}',
      mcp_url: discovery.canonicalMcpUrl,
      metadata: {
        zoho_hosted: discovery.zohoHosted,
        canonical_mcp_url: discovery.canonicalMcpUrl,
      },
    });

    const provider = providerKeyFromDiscovery({
      mcpServerName: input.mcpServerName,
      mcpUrl: discovery.canonicalMcpUrl,
      issuer: client.issuer,
    });

    const connection = upsertPendingConnection(input.userId, provider, {
      registrationId: registration.id,
      resource: discovery.resource.resource,
      mcpUrl: discovery.canonicalMcpUrl,
      mcpServerName: input.mcpServerName ?? null,
    });

    const state = randomBytes(24).toString('hex');
    const codeVerifier = newCodeVerifier();
    createOAuthState({
      state,
      userId: input.userId,
      provider,
      codeVerifier,
      workspaceId: input.workspaceId ?? null,
      buildJobId: input.buildJobId ?? null,
      registrationId: registration.id,
      resource: discovery.resource.resource,
      mcpUrl: discovery.canonicalMcpUrl,
      mcpServerName: input.mcpServerName ?? null,
    });

    const scopes =
      discovery.scopes.length > 0
        ? discovery.scopes
        : (() => {
            try {
              return JSON.parse(registration.scopes_supported_json) as string[];
            } catch {
              return [];
            }
          })();

    const authorizeUrl = buildAuthorizeUrl({
      registration: registrationToClient(registration),
      redirectUri: oauthRedirectUri(),
      state,
      codeVerifier,
      scopes,
      resource: discovery.resource.resource,
    });

    return {
      authorize_url: authorizeUrl,
      connection_id: connection.id,
      state,
      registration_id: registration.id,
      provider,
      mcp_url: discovery.canonicalMcpUrl,
    };
  }

  // Path B: legacy builtin provider
  const providerId = input.provider;
  if (!providerId) {
    throw new IntegrationError('Provide mcp_url or provider', 400);
  }
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new IntegrationError(`Unknown OAuth provider: ${providerId}`, 404);

  const connection = upsertPendingConnection(input.userId, provider.id);
  const state = randomBytes(24).toString('hex');
  const codeVerifier = newCodeVerifier();
  createOAuthState({
    state,
    userId: input.userId,
    provider: provider.id,
    codeVerifier,
    workspaceId: input.workspaceId ?? null,
  });

  const authorizeUrl = provider.buildAuthorizeUrl({
    redirectUri: oauthRedirectUri(),
    state,
    codeVerifier,
    scopes: input.scopes?.length ? input.scopes : provider.scopes,
  });

  return {
    authorize_url: authorizeUrl,
    connection_id: connection.id,
    state,
    provider: provider.id,
  };
}

export async function handleOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<{
  connection: OAuthConnectionPublic;
  workspace_id: string | null;
  build_job_id: string | null;
}> {
  const oauthState = consumeOAuthState(input.state);
  if (!oauthState) throw new IntegrationError('Invalid or expired OAuth state', 400);

  const connection = getConnectionForUserProvider(oauthState.user_id, oauthState.provider);
  if (!connection) throw new IntegrationError('OAuth connection not found', 404);

  try {
    let tokens;
    if (oauthState.registration_id) {
      const registration = getRegistration(oauthState.registration_id);
      if (!registration) throw new IntegrationError('OAuth registration missing', 400);
      if (!oauthState.code_verifier) {
        throw new IntegrationError('Missing PKCE code_verifier', 400);
      }
      tokens = await exchangeAuthorizationCode({
        registration: registrationToClient(registration),
        code: input.code,
        redirectUri: oauthRedirectUri(),
        codeVerifier: oauthState.code_verifier,
        resource: oauthState.resource,
      });
    } else {
      const provider = getOAuthProvider(oauthState.provider);
      if (!provider) {
        throw new IntegrationError(`Unknown OAuth provider: ${oauthState.provider}`, 404);
      }
      tokens = await provider.exchangeCode({
        code: input.code,
        redirectUri: oauthRedirectUri(),
        codeVerifier: oauthState.code_verifier,
      });
    }

    if (!tokens.refresh_token && !connection.refresh_token) {
      throw new IntegrationError(
        'Provider did not return a refresh token. Re-consent with offline access / prompt=consent.',
        400,
      );
    }

    let updated = applyTokenSet(connection.id, tokens);
    updated = await syncConnectionToOnecli(updated);

    let workspaceId = oauthState.workspace_id;

    if (oauthState.build_job_id) {
      const { getBuildJob, setBuildJobPendingMcp } = await import('../store/builds.js');
      const job = getBuildJob(oauthState.build_job_id);
      if (job) {
        setBuildJobPendingMcp(job.id, {
          mcpUrl: updated.mcp_url ?? oauthState.mcp_url,
          connectionId: updated.id,
          mcpServerName: updated.mcp_server_name ?? oauthState.mcp_server_name,
        });

        // If the agent was already created, attach now.
        if (job.result_workspace_id) {
          workspaceId = job.result_workspace_id;
          bindWorkspaceIntegration(job.result_workspace_id, updated.id);
          await attachRemoteMcpToWorkspace(job.result_workspace_id, updated);
          const workspace = getWorkspace(job.result_workspace_id);
          if (workspace?.agent_group_id && updated.onecli_secret_id) {
            try {
              await assignSecretToAgent(
                workspace.agent_group_id,
                updated.onecli_secret_id,
                workspace.name,
              );
            } catch (err) {
              log.warn('OneCLI agent secret assign deferred', { err });
            }
          }
        }

        // Notify Cliq / delivery channel
        if (job.delivery_channel_type && job.delivery_platform_id) {
          try {
            const { getChannelAdapter } = await import('../../channels/channel-registry.js');
            const adapter = getChannelAdapter(job.delivery_channel_type);
            await adapter?.deliver(job.delivery_platform_id, job.delivery_thread_id, {
              kind: 'chat',
              content: {
                text: [
                  'Remote MCP authorized successfully.',
                  updated.mcp_url ? `URL: ${updated.mcp_url}` : null,
                  job.result_workspace_id
                    ? 'It is attached to your agent — send a message to use it.'
                    : 'Continue the build in this chat. When the agent is created, this MCP will be attached automatically.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            });
          } catch (err) {
            log.warn('Failed to notify channel after MCP OAuth', { err });
          }
        }
      }
    }

    if (workspaceId && !oauthState.build_job_id) {
      bindWorkspaceIntegration(workspaceId, updated.id);
      await attachRemoteMcpToWorkspace(workspaceId, updated);
      const workspace = getWorkspace(workspaceId);
      if (workspace?.agent_group_id && updated.onecli_secret_id) {
        try {
          await assignSecretToAgent(
            workspace.agent_group_id,
            updated.onecli_secret_id,
            workspace.name,
          );
        } catch (err) {
          log.warn('OneCLI agent secret assign deferred until next agent run', {
            workspaceId,
            err,
          });
        }
      }
    } else if (workspaceId && oauthState.build_job_id && oauthState.workspace_id) {
      // already handled above when result_workspace set; if workspace_id was also set:
      bindWorkspaceIntegration(workspaceId, updated.id);
      await attachRemoteMcpToWorkspace(workspaceId, updated);
    }

    return {
      connection: toPublicConnection(updated),
      workspace_id: workspaceId,
      build_job_id: oauthState.build_job_id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setConnectionError(connection.id, message);
    throw err instanceof IntegrationError ? err : new IntegrationError(message, 400);
  }
}

/** Attach a pending build MCP connection to a newly created agent workspace. */
export async function applyBuildPendingMcpToAgent(
  job: {
    pending_connection_id: string | null;
    pending_mcp_url: string | null;
    pending_mcp_server_name: string | null;
  },
  workspaceId: string,
  agentGroupId: string,
): Promise<void> {
  if (!job.pending_connection_id) return;
  const connection = getConnection(job.pending_connection_id);
  if (!connection || connection.status !== 'connected') return;

  bindWorkspaceIntegration(workspaceId, connection.id);
  await attachRemoteMcpToWorkspace(workspaceId, {
    ...connection,
    mcp_url: connection.mcp_url ?? job.pending_mcp_url,
    mcp_server_name: connection.mcp_server_name ?? job.pending_mcp_server_name,
  });
  if (connection.onecli_secret_id) {
    const workspace = getWorkspace(workspaceId);
    try {
      await assignSecretToAgent(
        agentGroupId,
        connection.onecli_secret_id,
        workspace?.name,
      );
    } catch (err) {
      log.warn('OneCLI assign after build MCP attach deferred', { workspaceId, err });
    }
  }
}

async function syncConnectionToOnecli(connection: OAuthConnection): Promise<OAuthConnection> {
  if (!connection.access_token) {
    throw new IntegrationError('No access token to sync to OneCLI', 400);
  }

  let hostPattern: string;
  let headerName = 'Authorization';
  let valueFormat = 'Bearer {value}';

  if (connection.registration_id) {
    const reg = getRegistration(connection.registration_id);
    if (!reg) throw new IntegrationError('Registration missing for connection', 400);
    hostPattern = reg.host_pattern;
    headerName = reg.header_name;
    valueFormat = reg.value_format;
  } else {
    const provider = getOAuthProvider(connection.provider);
    if (!provider) throw new IntegrationError(`Unknown provider: ${connection.provider}`, 404);
    hostPattern = provider.hostPattern;
    headerName = provider.headerName ?? headerName;
    valueFormat = provider.valueFormat ?? valueFormat;
  }

  const secretId = await upsertAccessTokenSecret({
    name: secretName(connection),
    value: connection.access_token,
    hostPattern,
    headerName,
    valueFormat,
    existingSecretId: connection.onecli_secret_id,
  });
  setOnecliSecretId(connection.id, secretId);
  return getConnection(connection.id)!;
}

/**
 * Ensure remote MCP entry exists on the workspace container_config with a
 * placeholder Authorization header for OneCLI to overwrite.
 */
export async function attachRemoteMcpToWorkspace(
  workspaceId: string,
  connection: OAuthConnection,
): Promise<void> {
  if (!connection.mcp_url) return;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;

  const name =
    connection.mcp_server_name?.trim() ||
    connection.provider.replace(/^mcp:/, '').replace(/[^a-zA-Z0-9_-]/g, '_') ||
    'remote';

  const existing = workspace.container_config ?? defaultContainerConfig(workspace.name);
  const mcpServers: Record<string, McpServerConfig> = { ...(existing.mcpServers ?? {}) };
  const prev = mcpServers[name];

  const isZohoHosted =
    name === 'zoho-hosted' ||
    /zohomcp/i.test(connection.mcp_url) ||
    /zohomcp/i.test(connection.provider);

  const defaultInstructions = isZohoHosted
    ? [
        `Zoho-hosted MCP (${connection.mcp_url}). Auth is injected by OneCLI — do not paste tokens.`,
        'For contacts, CRM records, mail, and other Zoho data, call the zoho-hosted MCP tools — do not guess from general knowledge.',
      ].join(' ')
    : `Remote MCP (${connection.mcp_url}). Auth is injected by OneCLI — do not paste tokens.`;

  const nextEntry: McpServerConfig = {
    type: 'http',
    url: connection.mcp_url,
    headers: {
      ...(prev && 'headers' in prev ? prev.headers : {}),
      Authorization: `Bearer ${PLACEHOLDER_BEARER}`,
    },
    instructions: prev?.instructions ?? defaultInstructions,
  };

  if (
    prev &&
    prev.type === nextEntry.type &&
    prev.url === nextEntry.url &&
    JSON.stringify(prev.headers ?? {}) === JSON.stringify(nextEntry.headers ?? {}) &&
    (prev.instructions ?? '') === (nextEntry.instructions ?? '')
  ) {
    return;
  }

  mcpServers[name] = nextEntry;

  const nextConfig: ContainerConfigSnapshot = {
    ...existing,
    mcpServers,
  };

  updateWorkspaceMetadata(workspaceId, { container_config: nextConfig });
  log.info('Attached remote MCP to workspace config', { workspaceId, name, url: connection.mcp_url });
}

/**
 * Ensure access tokens for a workspace are fresh in OneCLI and assigned to
 * the agent. Call before / during worker prepare.
 */
export async function ensureWorkspaceIntegrations(workspaceId: string): Promise<void> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;

  const connections = listConnectionsForWorkspace(workspaceId).filter(
    (c) => c.status === 'connected' && c.refresh_token,
  );
  if (connections.length === 0) return;

  for (const connection of connections) {
    try {
      let current = connection;
      if (!accessTokenFresh(current)) {
        if (current.registration_id) {
          const registration = getRegistration(current.registration_id);
          if (!registration || !current.refresh_token) continue;
          const tokens = await refreshAccessToken({
            registration: registrationToClient(registration),
            refreshToken: current.refresh_token,
            resource: current.resource,
          });
          current = applyTokenSet(current.id, tokens, { keepRefreshIfMissing: true });
        } else {
          const provider = getOAuthProvider(current.provider);
          if (!provider || !current.refresh_token) continue;
          const tokens = await provider.refresh(current.refresh_token);
          current = applyTokenSet(current.id, tokens, { keepRefreshIfMissing: true });
        }
      }
      current = await syncConnectionToOnecli(current);
      if (current.mcp_url) {
        await attachRemoteMcpToWorkspace(workspaceId, current);
      }
      if (current.onecli_secret_id) {
        await assignSecretToAgent(
          workspace.agent_group_id,
          current.onecli_secret_id,
          workspace.name,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnectionError(connection.id, message);
      log.error('Failed to ensure workspace integration', {
        workspaceId,
        connectionId: connection.id,
        provider: connection.provider,
        err,
      });
    }
  }
}

export function bindIntegrationToWorkspace(
  workspaceId: string,
  connectionId: string,
  userId: string,
): OAuthConnectionPublic {
  assertAgentOwner(workspaceId, userId);
  const connection = getConnection(connectionId);
  if (!connection || connection.user_id !== userId) {
    throw new IntegrationError('Connection not found', 404);
  }
  if (connection.status !== 'connected') {
    throw new IntegrationError('Connection is not connected', 400);
  }
  bindWorkspaceIntegration(workspaceId, connectionId);
  if (connection.mcp_url) {
    void attachRemoteMcpToWorkspace(workspaceId, connection);
  }
  return toPublicConnection(connection);
}

export function unbindIntegrationFromWorkspace(
  workspaceId: string,
  connectionId: string,
  userId: string,
): void {
  assertAgentOwner(workspaceId, userId);
  unbindWorkspaceIntegration(workspaceId, connectionId);
}

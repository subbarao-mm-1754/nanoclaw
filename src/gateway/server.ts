import http from 'http';

import {
  GATEWAY_AUTH_TOKEN,
  GATEWAY_HOST,
  GATEWAY_PORT,
  WORKER_AUTH_TOKEN,
  WORKER_MAX_BODY_BYTES,
} from '../config.js';
import type { ContainerConfigSnapshot } from '../container-config.js';
import { createAgent, deleteAgent, getAgent, updateAgent } from './agent-service.js';
import {
  BuildError,
  continueBuild,
  getBuild,
  handleBuilderRunCallback,
  listBuilds,
  runPreviewTest,
  saveEdit,
  startBuild,
  startEdit,
} from './builder/service.js';
import {
  bindIntegrationToWorkspace,
  discoverAndRegister,
  handleOAuthCallback,
  IntegrationError,
  listProvidersPublic,
  listRegistrationsPublic,
  listUserIntegrations,
  listWorkspaceIntegrations,
  preRegisterClient,
  startOAuthConnect,
  unbindIntegrationFromWorkspace,
} from './integrations/broker.js';
import {
  bearerToken,
  jsonResponse,
  parseAgentFiles,
  readJsonBody,
  requireString,
  serveStatic,
} from './http-utils.js';
import { log } from '../log.js';
import { listChannelConnections } from './store/channels.js';
import { countMessagesByStatus, getMessage } from './store/messages.js';
import { listWorkspaces, registerWorkspace } from './store/workspaces.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getOrCreateConversation } from './store/conversations.js';
import { getHttpResponse, listHttpResponses } from './store/http-responses.js';
import { AuthError, createSession, createUser, deleteSession, getSession, loginUser } from './store/users.js';
import { AgentAccessError } from './store/agent-files.js';
import { AgentDeleteError } from './store/agents.js';
import { listUserAgents } from './store/agent-select.js';
import type { GatewayUser } from './types.js';
import type { WorkerProcessMessageResponse } from '../worker/types.js';

let server: http.Server | null = null;

function authorizeLegacy(req: http.IncomingMessage): boolean {
  if (!GATEWAY_AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === GATEWAY_AUTH_TOKEN;
}

function authorizeWorkerCallback(req: http.IncomingMessage): boolean {
  if (!WORKER_AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === WORKER_AUTH_TOKEN;
}

function requireUserSession(req: http.IncomingMessage): GatewayUser {
  const token = bearerToken(req);
  if (!token) throw new AuthError('Authentication required', 401);
  const session = getSession(token);
  if (!session) throw new AuthError('Invalid or expired session', 401);
  return session.user;
}

function parseContainerConfig(raw: unknown): ContainerConfigSnapshot | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('container_config must be an object');
  }
  return raw as ContainerConfigSnapshot;
}

async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const user = createUser({
    email: requireString(body, 'email'),
    password: requireString(body, 'password'),
    display_name: requireString(body, 'display_name'),
  });
  const session = createSession(user.id);
  jsonResponse(res, 201, { user, token: session.token, expires_at: session.expires_at });
}

async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const { user, session } = loginUser(requireString(body, 'email'), requireString(body, 'password'));
  jsonResponse(res, 200, { user, token: session.token, expires_at: session.expires_at });
}

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = bearerToken(req);
  if (token) deleteSession(token);
  jsonResponse(res, 200, { ok: true });
}

function handleMe(req: http.IncomingMessage, res: http.ServerResponse): void {
  const user = requireUserSession(req);
  jsonResponse(res, 200, { user });
}

async function handleCreateAgent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const files = parseAgentFiles(body.files);

  const agent = await createAgent({
    name: requireString(body, 'name'),
    owner_user_id: user.id,
    folder: typeof body.folder === 'string' ? body.folder : undefined,
    cli_scope: typeof body.cli_scope === 'string' ? body.cli_scope : undefined,
    container_config: parseContainerConfig(body.container_config),
    files,
    is_default: body.is_default === true,
  });

  jsonResponse(res, 201, { agent });
}

function handleListAgents(req: http.IncomingMessage, res: http.ServerResponse): void {
  const user = requireUserSession(req);
  const agents = listUserAgents(user.id).map((workspace) => ({
    ...workspace,
    files: getAgent(workspace.workspace_id, user.id)?.files ?? [],
  }));
  jsonResponse(res, 200, { agents });
}

function handleGetAgent(req: http.IncomingMessage, res: http.ServerResponse, workspaceId: string): void {
  const user = requireUserSession(req);
  const agent = getAgent(workspaceId, user.id);
  if (!agent) {
    jsonResponse(res, 404, { error: 'Agent not found' });
    return;
  }
  jsonResponse(res, 200, { agent });
}

async function handleUpdateAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;

  const agent = await updateAgent(workspaceId, user.id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    cli_scope: typeof body.cli_scope === 'string' ? body.cli_scope : undefined,
    container_config: parseContainerConfig(body.container_config),
    is_default: typeof body.is_default === 'boolean' ? body.is_default : undefined,
    files: body.files !== undefined ? parseAgentFiles(body.files) : undefined,
  });

  jsonResponse(res, 200, { agent });
}

async function handleDeleteAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const result = await deleteAgent(workspaceId, user.id);
  jsonResponse(res, 200, {
    ok: true,
    deleted: {
      workspace_id: result.agent.workspace_id,
      name: result.agent.name,
    },
    rebound_workspace_id: result.rebound_workspace_id,
    rebound_agent_name: result.rebound_agent_name,
    conversations_rebound: result.conversations_rebound,
    conversations_cleared: result.conversations_cleared,
  });
}

async function handleStartBuild(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  if (body.kind === 'edit') {
    const workspaceId = requireString(body, 'workspace_id');
    const agent = getAgent(workspaceId, user.id);
    if (!agent) {
      jsonResponse(res, 404, { error: 'Agent not found' });
      return;
    }
    const job = await startEdit(user, {
      agent,
      message: typeof body.message === 'string' ? body.message : undefined,
    });
    jsonResponse(res, 202, { job });
    return;
  }
  const job = await startBuild(user, {
    message: requireString(body, 'message'),
    title: typeof body.title === 'string' ? body.title : undefined,
  });
  jsonResponse(res, 202, { job });
}

function handleListBuilds(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const user = requireUserSession(req);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100);
  jsonResponse(res, 200, { jobs: listBuilds(user, limit) });
}

function handleGetBuild(req: http.IncomingMessage, res: http.ServerResponse, jobId: string): void {
  const user = requireUserSession(req);
  jsonResponse(res, 200, { job: getBuild(user, jobId) });
}

async function handleContinueBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const job = await continueBuild(user, jobId, {
    message: requireString(body, 'message'),
  });
  jsonResponse(res, 202, { job });
}

async function handlePreviewTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const job = await runPreviewTest(user, jobId, {
    message: requireString(body, 'message'),
  });
  jsonResponse(res, 202, { job });
}

async function handleSaveEdit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const job = await saveEdit(user, jobId);
  jsonResponse(res, 200, { job });
}

async function handleWorkerRunCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorizeWorkerCallback(req)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as WorkerProcessMessageResponse;
  if (!body || typeof body !== 'object' || typeof body.job_id !== 'string') {
    jsonResponse(res, 400, { error: 'job_id is required' });
    return;
  }

  await handleBuilderRunCallback(body);
  jsonResponse(res, 200, { ok: true });
}

async function handleRegisterWorkspace(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const workspace = registerWorkspace({
    workspace_id: requireString(body, 'workspace_id'),
    agent_group_id: requireString(body, 'agent_group_id'),
    name: requireString(body, 'name'),
    is_default: body.is_default === true,
  });
  jsonResponse(res, 200, workspace);
}

async function handleInjectInbound(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const channelType = requireString(body, 'channel_type');
  const platformId = requireString(body, 'platform_id');
  const threadId =
    body.thread_id === null || body.thread_id === undefined
      ? null
      : typeof body.thread_id === 'string'
        ? body.thread_id
        : (() => {
            throw new Error('thread_id must be a string or null');
          })();
  const content = body.content;
  if (!content || typeof content !== 'object') {
    throw new Error('content must be an object');
  }

  const conversation = getOrCreateConversation({
    channel_type: channelType,
    platform_id: platformId,
    thread_id: threadId,
    display_name: typeof body.display_name === 'string' ? body.display_name : undefined,
    workspace_id: typeof body.workspace_id === 'string' ? body.workspace_id : undefined,
  });

  const messageId =
    typeof body.id === 'string' && body.id.trim() !== ''
      ? body.id
      : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const message = enqueueInboundMessage(
    {
      id: messageId,
      channel_type: channelType,
      platform_id: platformId,
      thread_id: threadId,
      kind: typeof body.kind === 'string' ? body.kind : 'chat',
      content,
      timestamp: typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString(),
      sender_id: typeof body.sender_id === 'string' ? body.sender_id : platformId,
      sender_display_name: typeof body.sender_display_name === 'string' ? body.sender_display_name : undefined,
    },
    conversation.id,
  );

  jsonResponse(res, 202, { message, conversation });
}

function handleGetMessageResponse(res: http.ServerResponse, inboundId: string): void {
  const stored = getHttpResponse(inboundId);
  if (stored) {
    jsonResponse(res, 200, {
      status: 'completed',
      inbound_id: inboundId,
      outbound: stored.outbound,
      created_at: stored.created_at,
    });
    return;
  }

  const inbound = getMessage(inboundId);
  if (!inbound || inbound.direction !== 'inbound') {
    jsonResponse(res, 404, { error: 'Message not found' });
    return;
  }

  if (inbound.status === 'failed') {
    jsonResponse(res, 200, {
      status: 'failed',
      inbound_id: inboundId,
      error: inbound.error ?? 'Processing failed',
    });
    return;
  }

  jsonResponse(res, 200, {
    status: inbound.status === 'processing' ? 'processing' : 'pending',
    inbound_id: inboundId,
  });
}

function handleListHttpResponses(url: URL, res: http.ServerResponse): void {
  const platformId = url.searchParams.get('platform_id');
  if (!platformId) {
    jsonResponse(res, 400, { error: 'platform_id query parameter is required' });
    return;
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100);
  jsonResponse(res, 200, { responses: listHttpResponses(platformId, limit) });
}

function handleListIntegrationProviders(_req: http.IncomingMessage, res: http.ServerResponse): void {
  requireUserSession(_req);
  jsonResponse(res, 200, {
    providers: listProvidersPublic(),
    registrations: listRegistrationsPublic(),
  });
}

function handleListIntegrations(req: http.IncomingMessage, res: http.ServerResponse): void {
  const user = requireUserSession(req);
  jsonResponse(res, 200, { integrations: listUserIntegrations(user.id) });
}

async function handleDiscoverRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const mcpUrl = requireString(body, 'mcp_url');
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;
  const registration = await discoverAndRegister({ mcpUrl, scopes });
  jsonResponse(res, 200, { registration });
}

async function handlePreRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const registration = await preRegisterClient({
    issuer: requireString(body, 'issuer'),
    client_id: requireString(body, 'client_id'),
    client_secret: typeof body.client_secret === 'string' ? body.client_secret : null,
    mcp_url: typeof body.mcp_url === 'string' ? body.mcp_url : null,
    host_pattern: typeof body.host_pattern === 'string' ? body.host_pattern : null,
    scopes: Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string')
      : undefined,
    authorization_endpoint:
      typeof body.authorization_endpoint === 'string' ? body.authorization_endpoint : undefined,
    token_endpoint: typeof body.token_endpoint === 'string' ? body.token_endpoint : undefined,
  });
  jsonResponse(res, 201, { registration });
}

async function handleStartIntegrationConnectGeneric(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : undefined;
  const mcpUrl = typeof body.mcp_url === 'string' ? body.mcp_url : undefined;
  const provider = typeof body.provider === 'string' ? body.provider : undefined;
  const mcpServerName =
    typeof body.mcp_server_name === 'string' ? body.mcp_server_name : undefined;
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;

  const result = await startOAuthConnect({
    userId: user.id,
    mcpUrl,
    provider,
    mcpServerName,
    workspaceId,
    scopes,
  });
  jsonResponse(res, 200, result);
}

async function handleStartIntegrationConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: string,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : undefined;
  const result = await startOAuthConnect({
    userId: user.id,
    provider,
    workspaceId,
  });
  jsonResponse(res, 200, result);
}

async function handleOAuthCallbackHttp(url: URL, res: http.ServerResponse): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body><h1>OAuth failed</h1><p>${error}</p></body></html>`);
    return;
  }
  if (!code || !state) {
    jsonResponse(res, 400, { error: 'code and state are required' });
    return;
  }
  const result = await handleOAuthCallback({ code, state });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<html><body><h1>Connected</h1><p>Provider linked. You can close this window and return to Cliq.</p>` +
      `<pre>${JSON.stringify(result.connection, null, 2)}</pre></body></html>`,
  );
}

function handleListAgentIntegrations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): void {
  const user = requireUserSession(req);
  jsonResponse(res, 200, {
    integrations: listWorkspaceIntegrations(workspaceId, user.id),
  });
}

async function handleBindAgentIntegration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
  const connection = bindIntegrationToWorkspace(
    workspaceId,
    requireString(body, 'connection_id'),
    user.id,
  );
  jsonResponse(res, 200, { integration: connection });
}

function handleUnbindAgentIntegration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
  connectionId: string,
): void {
  const user = requireUserSession(req);
  unbindIntegrationFromWorkspace(workspaceId, connectionId, user.id);
  jsonResponse(res, 200, { ok: true });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    jsonResponse(res, 200, { status: 'ok' });
    return;
  }

  if (pathname.startsWith('/assets/') || pathname === '/') {
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    if (req.method === 'GET' && pathname === '/') {
      if (serveStatic(req, res, '/index.html')) return;
    }
  }

  const legacyAuth =
    pathname.startsWith('/v1/workspaces') ||
    pathname.startsWith('/v1/messages') ||
    pathname.startsWith('/v1/channels');
  if (legacyAuth && !authorizeLegacy(req)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    if (req.method === 'POST' && pathname === '/v1/auth/register') {
      await handleRegister(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/auth/login') {
      await handleLogin(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/auth/logout') {
      handleLogout(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/auth/me') {
      handleMe(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/agents') {
      handleListAgents(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/agents') {
      await handleCreateAgent(req, res);
      return;
    }

    const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (agentMatch) {
      const workspaceId = decodeURIComponent(agentMatch[1]!);
      if (req.method === 'GET') {
        handleGetAgent(req, res, workspaceId);
        return;
      }
      if (req.method === 'PATCH') {
        await handleUpdateAgent(req, res, workspaceId);
        return;
      }
      if (req.method === 'DELETE') {
        await handleDeleteAgent(req, res, workspaceId);
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/v1/builds') {
      handleListBuilds(req, res, url);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/builds') {
      await handleStartBuild(req, res);
      return;
    }

    const buildMatch = pathname.match(/^\/v1\/builds\/([^/]+)$/);
    if (buildMatch && req.method === 'GET') {
      handleGetBuild(req, res, decodeURIComponent(buildMatch[1]!));
      return;
    }

    const buildMessageMatch = pathname.match(/^\/v1\/builds\/([^/]+)\/messages$/);
    if (buildMessageMatch && req.method === 'POST') {
      await handleContinueBuild(req, res, decodeURIComponent(buildMessageMatch[1]!));
      return;
    }

    const buildTestMatch = pathname.match(/^\/v1\/builds\/([^/]+)\/test$/);
    if (buildTestMatch && req.method === 'POST') {
      await handlePreviewTest(req, res, decodeURIComponent(buildTestMatch[1]!));
      return;
    }

    const buildSaveMatch = pathname.match(/^\/v1\/builds\/([^/]+)\/save$/);
    if (buildSaveMatch && req.method === 'POST') {
      await handleSaveEdit(req, res, decodeURIComponent(buildSaveMatch[1]!));
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/worker/callbacks/run-result') {
      await handleWorkerRunCallback(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/workspaces') {
      jsonResponse(res, 200, { workspaces: listWorkspaces() });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/workspaces/register') {
      await handleRegisterWorkspace(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/channels') {
      jsonResponse(res, 200, { channels: listChannelConnections() });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/messages/stats') {
      jsonResponse(res, 200, { counts: countMessagesByStatus() });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/messages/responses') {
      handleListHttpResponses(url, res);
      return;
    }

    const responseMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/response$/);
    if (req.method === 'GET' && responseMatch) {
      handleGetMessageResponse(res, decodeURIComponent(responseMatch[1]!));
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/messages/inbound') {
      await handleInjectInbound(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/integrations/providers') {
      handleListIntegrationProviders(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/integrations') {
      handleListIntegrations(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/integrations/registrations') {
      requireUserSession(req);
      jsonResponse(res, 200, { registrations: listRegistrationsPublic() });
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/integrations/registrations') {
      await handlePreRegister(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/integrations/discover') {
      await handleDiscoverRegister(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/integrations/connect') {
      await handleStartIntegrationConnectGeneric(req, res);
      return;
    }
    const connectMatch = pathname.match(/^\/v1\/integrations\/([^/]+)\/connect$/);
    if (connectMatch && req.method === 'POST') {
      const name = decodeURIComponent(connectMatch[1]!);
      if (name !== 'oauth' && name !== 'discover' && name !== 'registrations' && name !== 'connect') {
        await handleStartIntegrationConnect(req, res, name);
        return;
      }
    }
    if (req.method === 'GET' && pathname === '/v1/integrations/oauth/callback') {
      await handleOAuthCallbackHttp(url, res);
      return;
    }

    const agentIntegrationsMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/integrations$/);
    if (agentIntegrationsMatch) {
      const workspaceId = decodeURIComponent(agentIntegrationsMatch[1]!);
      if (req.method === 'GET') {
        handleListAgentIntegrations(req, res, workspaceId);
        return;
      }
      if (req.method === 'POST') {
        await handleBindAgentIntegration(req, res, workspaceId);
        return;
      }
    }
    const agentIntegrationItemMatch = pathname.match(
      /^\/v1\/agents\/([^/]+)\/integrations\/([^/]+)$/,
    );
    if (agentIntegrationItemMatch && req.method === 'DELETE') {
      handleUnbindAgentIntegration(
        req,
        res,
        decodeURIComponent(agentIntegrationItemMatch[1]!),
        decodeURIComponent(agentIntegrationItemMatch[2]!),
      );
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof AuthError) {
      jsonResponse(res, err.status, { error: err.message });
      return;
    }
    if (err instanceof AgentAccessError) {
      jsonResponse(res, err.status, { error: err.message });
      return;
    }
    if (err instanceof AgentDeleteError) {
      jsonResponse(res, err.status, { error: err.message });
      return;
    }
    if (err instanceof BuildError) {
      jsonResponse(res, err.status, { error: err.message });
      return;
    }
    if (err instanceof IntegrationError) {
      jsonResponse(res, err.status, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 400, { error: message });
  }
}

export async function startGatewayServer(): Promise<void> {
  if (server) return;

  server = http.createServer((req, res) => {
    void route(req, res).catch((err) => {
      log.error('Gateway HTTP handler error', { err });
      jsonResponse(res, 500, { error: 'Internal server error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.listen(GATEWAY_PORT, GATEWAY_HOST, () => resolve());
    server!.on('error', reject);
  });

  log.info('Gateway HTTP server listening', { host: GATEWAY_HOST, port: GATEWAY_PORT });
}

export async function stopGatewayServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => (err ? reject(err) : resolve()));
  });
  server = null;
}

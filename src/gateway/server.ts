import http from 'http';

import {
  GATEWAY_AUTH_TOKEN,
  GATEWAY_HOST,
  GATEWAY_PORT,
  WORKER_AUTH_TOKEN,
  WORKER_MAX_BODY_BYTES,
} from '../config.js';
import type { ContainerConfigSnapshot } from '../container-config.js';
import { createAgent, getAgent, updateAgent } from './agent-service.js';
import {
  BuildError,
  continueBuild,
  getBuild,
  handleBuilderRunCallback,
  listBuilds,
  startBuild,
} from './builder/service.js';
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
import { listAgentsForUser } from './store/agents.js';
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
  const agents = listAgentsForUser(user.id)
    .filter((workspace) => !workspace.workspace_id.startsWith('ws-builder-'))
    .map((workspace) => ({
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

async function handleStartBuild(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const user = requireUserSession(req);
  const body = (await readJsonBody(req, WORKER_MAX_BODY_BYTES)) as Record<string, unknown>;
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
    if (err instanceof BuildError) {
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

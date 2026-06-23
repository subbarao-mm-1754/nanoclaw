import http from 'http';

import {
  GATEWAY_AUTH_TOKEN,
  GATEWAY_HOST,
  GATEWAY_PORT,
  WORKER_MAX_BODY_BYTES,
} from '../config.js';
import { log } from '../log.js';
import { listChannelConnections } from './store/channels.js';
import { countMessagesByStatus, getMessage } from './store/messages.js';
import { listWorkspaces, registerWorkspace } from './store/workspaces.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getOrCreateConversation } from './store/conversations.js';
import { getHttpResponse, listHttpResponses } from './store/http-responses.js';

let server: http.Server | null = null;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > WORKER_MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function authorize(req: http.IncomingMessage): boolean {
  if (!GATEWAY_AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === GATEWAY_AUTH_TOKEN;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

async function handleRegisterWorkspace(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const workspace = registerWorkspace({
    workspace_id: requireString(body, 'workspace_id'),
    agent_group_id: requireString(body, 'agent_group_id'),
    name: requireString(body, 'name'),
    is_default: body.is_default === true,
  });
  jsonResponse(res, 200, workspace);
}

async function handleInjectInbound(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
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

  const needsAuth =
    pathname.startsWith('/v1/workspaces') ||
    pathname.startsWith('/v1/messages') ||
    pathname.startsWith('/v1/channels');
  if (needsAuth && !authorize(req)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
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

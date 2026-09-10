import http from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';

import {
  GATEWAY_WORKER_URL,
  LIVE_BROWSER_ENABLED,
  WORKER_AUTH_TOKEN,
} from '../../config.js';
import { log } from '../../log.js';
import { assertAgentOwner, AgentAccessError } from '../../gateway/store/agent-files.js';
import type { GatewayUser } from '../../gateway/types.js';
import { issueLiveBrowserTicket, consumeLiveBrowserTicket } from './tickets.js';
import { proxyWebSocketUpgrade } from './ws-proxy.js';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (WORKER_AUTH_TOKEN) headers.set('Authorization', `Bearer ${WORKER_AUTH_TOKEN}`);
  return fetch(`${GATEWAY_WORKER_URL.replace(/\/$/, '')}${path}`, { ...init, headers });
}

/**
 * Gateway HTTP routes. `getUser` must throw AuthError / return user.
 * Returns true if handled.
 */
export async function handleGatewayLiveBrowserHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  getUser: () => GatewayUser,
): Promise<boolean> {
  // Feature probe (no auth) — UI hides the panel when disabled
  if (req.method === 'GET' && pathname === '/v1/live-browser/enabled') {
    json(res, 200, { enabled: LIVE_BROWSER_ENABLED });
    return true;
  }

  const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/live-browser(?:\/(.*))?$/);
  if (!agentMatch) return false;

  const workspaceId = decodeURIComponent(agentMatch[1]!);
  const rest = agentMatch[2] ?? '';

  if (!LIVE_BROWSER_ENABLED) {
    json(res, 503, { error: 'Live browser is disabled (set LIVE_BROWSER_ENABLED=true)' });
    return true;
  }

  let user: GatewayUser;
  try {
    user = getUser();
    assertAgentOwner(workspaceId, user.id);
  } catch (err) {
    if (err instanceof AgentAccessError) {
      json(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }

  try {
    if (req.method === 'GET' && (rest === '' || rest === 'status')) {
      const wr = await workerFetch(
        `/v1/live-browser/status?workspace_id=${encodeURIComponent(workspaceId)}`,
      );
      const body = await wr.json().catch(() => ({}));
      json(res, wr.status, body);
      return true;
    }

    if (req.method === 'POST' && rest === 'ticket') {
      const issued = issueLiveBrowserTicket({
        userId: user.id,
        workspaceId,
        mode: 'control',
      });
      json(res, 200, {
        ...issued,
        stream_path: `/v1/agents/${encodeURIComponent(workspaceId)}/live-browser/stream`,
      });
      return true;
    }

    if (req.method === 'POST' && rest === 'take-control') {
      const wr = await workerFetch('/v1/live-browser/take-control', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = await wr.json().catch(() => ({}));
      json(res, wr.status, body);
      return true;
    }

    if (req.method === 'POST' && rest === 'release-control') {
      const wr = await workerFetch('/v1/live-browser/release-control', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const body = await wr.json().catch(() => ({}));
      json(res, wr.status, body);
      return true;
    }
  } catch (err) {
    log.error('Gateway live-browser route error', { workspaceId, err });
    json(res, 502, { error: err instanceof Error ? err.message : 'Worker unreachable' });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

/**
 * Gateway WS upgrade for /v1/agents/:id/live-browser/stream?ticket=
 */
export async function handleGatewayLiveBrowserUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\/v1\/agents\/([^/]+)\/live-browser\/stream$/);
  if (!match) return false;

  if (!LIVE_BROWSER_ENABLED) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nDisabled');
    socket.destroy();
    return true;
  }

  const workspaceId = decodeURIComponent(match[1]!);
  const ticket = url.searchParams.get('ticket') || '';
  const row = consumeLiveBrowserTicket(ticket);
  if (!row || row.workspaceId !== workspaceId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nInvalid or expired ticket');
    socket.destroy();
    return true;
  }

  try {
    assertAgentOwner(workspaceId, row.userId);
  } catch {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  const workerUrl = new URL(GATEWAY_WORKER_URL);
  const targetPath = `/v1/live-browser/stream?workspace_id=${encodeURIComponent(workspaceId)}`;
  const upstreamHeaders: Record<string, string> = {};
  if (WORKER_AUTH_TOKEN) {
    upstreamHeaders.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;
  }

  try {
    await proxyWebSocketUpgrade({
      clientReq: req,
      clientSocket: socket,
      clientHead: head,
      targetHost: workerUrl.hostname,
      targetPort: parseInt(workerUrl.port || '80', 10),
      targetPath,
      upstreamHeaders,
      // Worker accepts any origin; it rewrites again toward the container.
      upstreamOrigin: 'http://127.0.0.1',
    });
  } catch (err) {
    log.warn('Gateway live-browser stream proxy failed', { workspaceId, err });
    if (!socket.destroyed) socket.destroy();
  }
  return true;
}

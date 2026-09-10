import http from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';

import { LIVE_BROWSER_ENABLED, WORKER_AUTH_TOKEN } from '../../config.js';
import { log } from '../../log.js';
import {
  LiveBrowserError,
  forceLiveBrowserPaint,
  probeStreamPort,
  publicEndpointStatus,
  releaseControl,
  resolveEndpoint,
  takeControl,
} from './handoff.js';
import { proxyWebSocketToContainerStream } from './ws-proxy.js';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorize(req: http.IncomingMessage): boolean {
  if (!WORKER_AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === WORKER_AUTH_TOKEN;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Worker HTTP routes for live browser.
 * Returns true if the request was handled.
 */
export async function handleWorkerLiveBrowserHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/live-browser')) return false;

  if (!LIVE_BROWSER_ENABLED) {
    json(res, 503, { error: 'Live browser is disabled (set LIVE_BROWSER_ENABLED=true)' });
    return true;
  }

  if (!authorize(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  try {
    if (req.method === 'GET' && pathname === '/v1/live-browser/status') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const workspaceId = url.searchParams.get('workspace_id') || undefined;
      const sessionId = url.searchParams.get('session_id') || undefined;
      if (!workspaceId && !sessionId) {
        json(res, 400, { error: 'workspace_id or session_id required' });
        return true;
      }
      const ep = resolveEndpoint({ workspaceId, sessionId });
      if (!ep) {
        json(res, 200, {
          enabled: true,
          available: false,
          stream_ready: false,
          reason:
            'No running container registered for live browser. Send the agent a message so its container starts (with LIVE_BROWSER_ENABLED), then retry.',
        });
        return true;
      }
      const streamReady = await probeStreamPort(ep);
      json(res, 200, await publicEndpointStatus(ep, streamReady));
      return true;
    }

    if (req.method === 'POST' && pathname === '/v1/live-browser/take-control') {
      const body = (await readJson(req)) as { workspace_id?: string };
      if (!body.workspace_id) {
        json(res, 400, { error: 'workspace_id required' });
        return true;
      }
      const ep = await takeControl(body.workspace_id);
      json(res, 200, { ok: true, control: ep.control, session_id: ep.sessionId });
      return true;
    }

    if (req.method === 'POST' && pathname === '/v1/live-browser/release-control') {
      const body = (await readJson(req)) as { workspace_id?: string };
      if (!body.workspace_id) {
        json(res, 400, { error: 'workspace_id required' });
        return true;
      }
      const ep = await releaseControl(body.workspace_id);
      json(res, 200, { ok: true, control: ep.control, session_id: ep.sessionId });
      return true;
    }
  } catch (err) {
    if (err instanceof LiveBrowserError) {
      json(res, err.status, { error: err.message });
      return true;
    }
    log.error('Worker live-browser handler error', { err });
    json(res, 500, { error: 'Internal error' });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

/**
 * Worker WS upgrade: /v1/live-browser/stream?workspace_id=
 */
export async function handleWorkerLiveBrowserUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/v1/live-browser/stream') return false;

  if (!LIVE_BROWSER_ENABLED) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nDisabled');
    socket.destroy();
    return true;
  }

  if (!authorize(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  const workspaceId = url.searchParams.get('workspace_id') || undefined;
  const sessionId = url.searchParams.get('session_id') || undefined;
  const ep = resolveEndpoint({ workspaceId, sessionId });
  if (!ep) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nNo live endpoint');
    socket.destroy();
    return true;
  }

  const ready = await probeStreamPort(ep);
  if (!ready) {
    socket.write(
      'HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\nStream not ready — agent must open a page first',
    );
    socket.destroy();
    return true;
  }

  // Force a compositor paint so the first screencast frames are not black.
  try {
    await forceLiveBrowserPaint(ep.containerName, ep.browserSession);
  } catch (err) {
    log.debug('Live browser paint flush failed (continuing)', { err });
  }

  try {
    await proxyWebSocketToContainerStream({
      clientReq: req,
      clientSocket: socket,
      clientHead: head,
      containerName: ep.containerName,
      containerPort: ep.containerPort,
      upstreamOrigin: 'http://127.0.0.1',
    });
  } catch (err) {
    log.warn('Worker live-browser stream proxy failed', { err });
    if (!socket.destroyed) socket.destroy();
  }
  return true;
}

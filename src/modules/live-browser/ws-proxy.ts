import http from 'http';
import type { Duplex } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';

import { log } from '../../log.js';
import { spawnContainerLocalhostRelay } from './container-relay.js';

/**
 * Transparent WebSocket reverse proxy to agent-browser inside a container.
 * agent-browser binds 127.0.0.1 only — we reach it via docker exec TCP relay.
 * Same Sec-WebSocket-Key is forwarded so Accept stays valid for the browser client.
 */
export async function proxyWebSocketToContainerStream(opts: {
  clientReq: http.IncomingMessage;
  clientSocket: Duplex;
  clientHead: Buffer;
  containerName: string;
  containerPort: number;
  upstreamOrigin?: string;
}): Promise<void> {
  const {
    clientReq,
    clientSocket,
    clientHead,
    containerName,
    containerPort,
    upstreamOrigin = 'http://127.0.0.1',
  } = opts;

  const key = clientReq.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    clientSocket.write(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nMissing Sec-WebSocket-Key',
    );
    clientSocket.destroy();
    return;
  }

  let relay: ChildProcessWithoutNullStreams;
  try {
    relay = spawnContainerLocalhostRelay(containerName, containerPort);
  } catch (err) {
    log.warn('Live browser relay spawn failed', { containerName, err });
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nRelay spawn failed');
    clientSocket.destroy();
    return;
  }

  const upstream = relay.stdin;
  const downstream = relay.stdout;

  relay.stderr?.on('data', (chunk: Buffer) => {
    log.debug('Live browser relay stderr', { containerName, msg: chunk.toString().slice(0, 200) });
  });

  relay.on('error', (err) => {
    log.warn('Live browser relay process error', { containerName, err });
    clientSocket.destroy();
  });

  // Prefer push+maxFps over ack pacing: agent-browser 0.27.x often stalls after
  // the first frame when ack mode is requested (frames=1 forever on about:blank
  // or any static page). Push with a cap stays live through the docker-exec relay.
  const headerLines = [
    'GET /?pacing=push&maxFps=8 HTTP/1.1',
    `Host: 127.0.0.1:${containerPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: ${clientReq.headers['sec-websocket-version'] || '13'}`,
    `Origin: ${upstreamOrigin}`,
  ];
  if (clientReq.headers['sec-websocket-protocol']) {
    headerLines.push(`Sec-WebSocket-Protocol: ${clientReq.headers['sec-websocket-protocol']}`);
  }
  headerLines.push('', '');

  let responseBuf = Buffer.alloc(0);
  let headerDone = false;
  let settled = false;

  const fail = (statusLine: string, detail: string) => {
    if (settled) return;
    settled = true;
    log.warn('Live browser stream upgrade failed', { containerName, statusLine, detail });
    try {
      clientSocket.write(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${detail}`,
      );
    } catch {
      // ignore
    }
    clientSocket.destroy();
    relay.kill('SIGKILL');
  };

  const onData = (chunk: Buffer) => {
    if (headerDone) return;
    responseBuf = Buffer.concat([responseBuf, chunk]);
    const idx = responseBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;

    headerDone = true;
    settled = true;
    const headerPart = responseBuf.subarray(0, idx).toString('utf8');
    const rest = responseBuf.subarray(idx + 4);
    downstream.off('data', onData);

    const statusLine = headerPart.split('\r\n')[0] || '';
    if (!statusLine.includes('101')) {
      fail(statusLine, `Upstream: ${statusLine}`);
      return;
    }

    clientSocket.write(responseBuf.subarray(0, idx + 4));
    if (rest.length) clientSocket.write(rest);
    if (clientHead.length) upstream.write(clientHead);

    clientSocket.pipe(upstream);
    downstream.pipe(clientSocket);

    const cleanup = () => {
      clientSocket.destroy();
      relay.kill('SIGKILL');
    };
    clientSocket.on('error', cleanup);
    clientSocket.on('close', () => relay.kill('SIGKILL'));
    relay.on('exit', () => clientSocket.destroy());
  };

  downstream.on('data', onData);

  relay.on('exit', (code) => {
    if (!headerDone) {
      fail(`relay-exit-${code}`, 'Stream not reachable inside container (is agent-browser open?)');
    }
  });

  upstream.write(headerLines.join('\r\n'));
}

/** Host↔host (or gateway↔worker) transparent WS proxy with Origin rewrite. */
export async function proxyWebSocketUpgrade(opts: {
  clientReq: http.IncomingMessage;
  clientSocket: Duplex;
  clientHead: Buffer;
  targetHost: string;
  targetPort: number;
  targetPath: string;
  upstreamHeaders?: Record<string, string>;
  upstreamOrigin?: string;
}): Promise<void> {
  const net = await import('net');
  const {
    clientReq,
    clientSocket,
    clientHead,
    targetHost,
    targetPort,
    targetPath,
    upstreamHeaders = {},
    upstreamOrigin = 'http://127.0.0.1',
  } = opts;

  const key = clientReq.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    clientSocket.write(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nMissing Sec-WebSocket-Key',
    );
    clientSocket.destroy();
    return;
  }

  const sock = net.connect({ host: targetHost, port: targetPort });

  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
  } catch (err) {
    log.warn('Live browser upstream connect failed', { targetHost, targetPort, err });
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream unavailable');
    clientSocket.destroy();
    sock.destroy();
    return;
  }

  const headerLines = [
    `GET ${targetPath} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: ${clientReq.headers['sec-websocket-version'] || '13'}`,
    `Origin: ${upstreamOrigin}`,
  ];
  if (clientReq.headers['sec-websocket-protocol']) {
    headerLines.push(`Sec-WebSocket-Protocol: ${clientReq.headers['sec-websocket-protocol']}`);
  }
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    headerLines.push(`${k}: ${v}`);
  }
  headerLines.push('', '');
  sock.write(headerLines.join('\r\n'));

  let responseBuf = Buffer.alloc(0);
  let headerDone = false;

  const onData = (chunk: Buffer) => {
    if (headerDone) return;
    responseBuf = Buffer.concat([responseBuf, chunk]);
    const idx = responseBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;

    headerDone = true;
    const headerPart = responseBuf.subarray(0, idx).toString('utf8');
    const rest = responseBuf.subarray(idx + 4);
    sock.off('data', onData);

    const statusLine = headerPart.split('\r\n')[0] || '';
    if (!statusLine.includes('101')) {
      log.warn('Live browser upstream rejected upgrade', { statusLine });
      clientSocket.write(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nUpstream: ${statusLine}`,
      );
      clientSocket.destroy();
      sock.destroy();
      return;
    }

    clientSocket.write(responseBuf.subarray(0, idx + 4));
    if (rest.length) clientSocket.write(rest);
    if (clientHead.length) sock.write(clientHead);

    clientSocket.pipe(sock);
    sock.pipe(clientSocket);

    const cleanup = () => {
      clientSocket.destroy();
      sock.destroy();
    };
    clientSocket.on('error', cleanup);
    sock.on('error', cleanup);
    clientSocket.on('close', () => sock.destroy());
    sock.on('close', () => clientSocket.destroy());
  };

  sock.on('data', onData);
}

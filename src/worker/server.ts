import http from 'http';

import { WORKER_AUTH_TOKEN, WORKER_HOST, WORKER_MAX_BODY_BYTES, WORKER_PORT } from '../config.js';
import { log } from '../log.js';
import { runProcessMessageJob } from './job-runner.js';
import { runPrepareWorkspace } from './prepare-workspace.js';
import type { WorkerPrepareWorkspaceResponse, WorkerProcessMessageResponse } from './types.js';
import { isMultipartRequest, parseMultipartPrepareRequest } from './multipart.js';
import {
  WorkerValidationError,
  parsePrepareWorkspaceRequest,
  parseProcessMessageRequest,
} from './validate.js';

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
  if (!WORKER_AUTH_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === WORKER_AUTH_TOKEN;
}

function validationErrorResponse(res: http.ServerResponse, err: WorkerValidationError): void {
  jsonResponse(res, 400, { error: err.message });
}

async function handlePrepareWorkspace(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorize(req)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  let prepareReq;
  try {
    if (isMultipartRequest(req)) {
      const { metadata, attachments } = await parseMultipartPrepareRequest(req);
      prepareReq = parsePrepareWorkspaceRequest(metadata, attachments);
    } else {
      const body = await readJsonBody(req);
      prepareReq = parsePrepareWorkspaceRequest(body);
    }
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    jsonResponse(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    return;
  }

  try {
    const result: WorkerPrepareWorkspaceResponse = runPrepareWorkspace(prepareReq);
    jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    log.error('Worker prepare-workspace failed', { workspaceId: prepareReq.workspace_id, err });
    jsonResponse(res, 500, {
      workspace_id: prepareReq.workspace_id,
      status: 'failed',
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
}

async function handleProcessMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorize(req)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
    return;
  }

  let job;
  try {
    job = parseProcessMessageRequest(body);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    throw err;
  }

  try {
    const result: WorkerProcessMessageResponse = await runProcessMessageJob(job);
    jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    log.error('Worker process-message failed', { jobId: job.job_id, err });
    jsonResponse(res, 500, {
      job_id: job.job_id,
      workspace_id: job.workspace_id,
      status: 'failed',
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    jsonResponse(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/workspaces/prepare') {
    await handlePrepareWorkspace(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/jobs/process-message') {
    await handleProcessMessage(req, res);
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

export function startWorkerServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        log.error('Worker HTTP handler error', { err });
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: 'Internal error' });
        }
      });
    });

    s.once('error', reject);
    s.listen(WORKER_PORT, WORKER_HOST, () => {
      server = s;
      log.info('NanoClaw worker listening', { host: WORKER_HOST, port: WORKER_PORT });
      resolve();
    });
  });
}

export async function stopWorkerServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  });
}

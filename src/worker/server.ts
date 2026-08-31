import http from 'http';

import { WORKER_AUTH_TOKEN, WORKER_HOST, WORKER_MAX_BODY_BYTES, WORKER_PORT } from '../config.js';
import { log } from '../log.js';
import { runDestroyWorkspace } from './destroy-workspace.js';
import { runProcessMessageJob } from './job-runner.js';
import { runPrepareWorkspace } from './prepare-workspace.js';
import type {
  WorkerPrepareWorkspaceResponse,
  WorkerProcessMessageRequest,
  WorkerProcessMessageResponse,
} from './types.js';
import { isMultipartRequest, parseMultipartPrepareRequest } from './multipart.js';
import {
  WorkerValidationError,
  parseDestroyWorkspaceRequest,
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

async function postCallback(
  callbackUrl: string,
  result: WorkerProcessMessageResponse,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;

  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(result),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Callback failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function runAndCallback(job: WorkerProcessMessageRequest): Promise<void> {
  const callbackUrl = job.options?.callback_url;
  if (!callbackUrl) {
    log.error('Async process-message missing callback_url', { jobId: job.job_id });
    return;
  }

  try {
    const result = await runProcessMessageJob(job);
    await postCallback(callbackUrl, result);
    log.info('Worker async run callback delivered', {
      jobId: job.job_id,
      buildJobId: job.build_job_id,
      status: result.status,
    });
  } catch (err) {
    log.error('Worker async run failed', { jobId: job.job_id, err });
    const failure: WorkerProcessMessageResponse = {
      job_id: job.job_id,
      build_job_id: job.build_job_id,
      status: 'failed',
      workspace_id: job.workspace_id,
      session: job.session,
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: job.inbound.id,
      error: err instanceof Error ? err.message : 'Internal error',
    };
    try {
      await postCallback(callbackUrl, failure);
    } catch (cbErr) {
      log.error('Worker async failure callback failed', { jobId: job.job_id, err: cbErr });
    }
  }
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

async function handleDestroyWorkspace(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  let destroyReq;
  try {
    destroyReq = parseDestroyWorkspaceRequest(body);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    throw err;
  }

  try {
    const result = runDestroyWorkspace(destroyReq);
    jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    log.error('Worker destroy-workspace failed', { workspaceId: destroyReq.workspace_id, err });
    jsonResponse(res, 500, {
      workspace_id: destroyReq.workspace_id,
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

  let job: WorkerProcessMessageRequest;
  try {
    job = parseProcessMessageRequest(body);
  } catch (err) {
    if (err instanceof WorkerValidationError) {
      validationErrorResponse(res, err);
      return;
    }
    throw err;
  }

  if (job.options?.async) {
    jsonResponse(res, 202, {
      job_id: job.job_id,
      build_job_id: job.build_job_id,
      status: 'accepted',
    });
    void runAndCallback(job);
    return;
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
      build_job_id: job.build_job_id,
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

  if (req.method === 'POST' && url.pathname === '/v1/workspaces/destroy') {
    await handleDestroyWorkspace(req, res);
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

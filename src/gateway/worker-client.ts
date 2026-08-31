import {
  GATEWAY_PUBLIC_URL,
  GATEWAY_WORKER_URL,
  WORKER_AUTH_TOKEN,
  WORKER_JOB_TIMEOUT_MS,
} from '../config.js';
import { log } from '../log.js';
import type {
  WorkerMemoryPatch,
  WorkerProcessMessageRequest,
  WorkerProcessMessageResponse,
  WorkerPrepareWorkspaceRequest,
  WorkerPrepareWorkspaceResponse,
} from '../worker/types.js';

function workerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;
  return headers;
}

export async function processMessageOnWorker(
  payload: WorkerProcessMessageRequest,
): Promise<WorkerProcessMessageResponse> {
  const timeoutMs = payload.options?.timeout_ms ?? WORKER_JOB_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

  try {
    const res = await fetch(`${GATEWAY_WORKER_URL}/v1/jobs/process-message`, {
      method: 'POST',
      headers: workerHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: WorkerProcessMessageResponse & { error?: string };
    try {
      body = JSON.parse(text) as WorkerProcessMessageResponse & { error?: string };
    } catch {
      throw new Error(`Worker returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new Error(body.error || `Worker HTTP ${res.status}`);
    }

    return body;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.error('Worker request timed out', { jobId: payload.job_id, timeoutMs });
      throw new Error(`Worker request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enqueue a Worker run asynchronously. Worker returns 202 immediately and later
 * POSTs the result to the Gateway callback URL.
 */
export async function enqueueProcessMessageOnWorker(
  payload: WorkerProcessMessageRequest,
  buildJobId: string,
): Promise<{ run_id: string; status: 'accepted' }> {
  const callbackUrl = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/worker/callbacks/run-result`;
  const body = {
    ...payload,
    build_job_id: buildJobId,
    options: {
      ...payload.options,
      async: true,
      callback_url: callbackUrl,
    },
  };

  const res = await fetch(`${GATEWAY_WORKER_URL}/v1/jobs/process-message`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: { job_id?: string; status?: string; error?: string };
  try {
    parsed = JSON.parse(text) as { job_id?: string; status?: string; error?: string };
  } catch {
    throw new Error(`Worker returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (res.status !== 202 && !res.ok) {
    throw new Error(parsed.error || `Worker HTTP ${res.status}`);
  }

  return { run_id: parsed.job_id || payload.job_id, status: 'accepted' };
}

export async function prepareWorkspaceOnWorker(
  payload: WorkerPrepareWorkspaceRequest,
): Promise<WorkerPrepareWorkspaceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(`${GATEWAY_WORKER_URL}/v1/workspaces/prepare`, {
      method: 'POST',
      headers: workerHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: WorkerPrepareWorkspaceResponse & { error?: string };
    try {
      body = JSON.parse(text) as WorkerPrepareWorkspaceResponse & { error?: string };
    } catch {
      throw new Error(`Worker returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new Error(body.error || `Worker HTTP ${res.status}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function destroyWorkspaceOnWorker(input: {
  workspace_id: string;
  session_id?: string;
}): Promise<void> {
  const res = await fetch(`${GATEWAY_WORKER_URL}/v1/workspaces/destroy`, {
    method: 'POST',
    headers: workerHeaders(),
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    let error = `Worker HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) error = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(error);
  }
}

export type {
  WorkerMemoryPatch,
  WorkerPrepareWorkspaceRequest,
  WorkerPrepareWorkspaceResponse,
};

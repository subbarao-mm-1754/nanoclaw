import {
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

export type {
  WorkerMemoryPatch,
  WorkerPrepareWorkspaceRequest,
  WorkerPrepareWorkspaceResponse,
};

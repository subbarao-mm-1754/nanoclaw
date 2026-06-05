import {
  getDeliveredIds,
  getDueOutboundMessages,
  markDelivered,
  migrateDeliveredTable,
} from '../db/session-db.js';
import { log } from '../log.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from '../session-manager.js';
import { isContainerRunning } from '../container-runner.js';
import type { WorkerCollectedOutbound, WorkerJobRequest } from './types.js';

const POLL_MS = 1000;
const POST_STOP_GRACE_MS = 2000;

function matchesDelivery(
  msg: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
  delivery: WorkerJobRequest['delivery'],
): boolean {
  if (msg.channel_type !== delivery.channel_type) return false;
  if (msg.platform_id !== delivery.platform_id) return false;
  if (delivery.thread_id !== null && msg.thread_id !== delivery.thread_id) return false;
  return true;
}

function encodeFiles(files: Array<{ filename: string; data: Buffer }>): WorkerCollectedOutbound['files'] {
  return files.map((f) => ({
    filename: f.filename,
    data_base64: f.data.toString('base64'),
  }));
}

export interface CollectOutboundOptions {
  agentGroupId: string;
  sessionId: string;
  delivery: WorkerJobRequest['delivery'];
  timeoutMs: number;
}

/**
 * Poll outbound.db until the container stops (or times out) and collect
 * user-facing chat messages for the job's delivery address.
 */
export async function collectOutboundMessages(opts: CollectOutboundOptions): Promise<WorkerCollectedOutbound[]> {
  const { agentGroupId, sessionId, delivery, timeoutMs } = opts;
  const collected: WorkerCollectedOutbound[] = [];
  const collectedIds = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let containerStoppedAt: number | null = null;

  while (Date.now() < deadline) {
    const batch = drainOutboundBatch(agentGroupId, sessionId, delivery, collectedIds);
    for (const msg of batch) {
      collected.push(msg);
      collectedIds.add(msg.id);
    }

    if (!isContainerRunning(sessionId)) {
      if (containerStoppedAt === null) {
        containerStoppedAt = Date.now();
      }
      const quiet = batch.length === 0;
      const graceElapsed = Date.now() - containerStoppedAt >= POST_STOP_GRACE_MS;
      if (quiet && (collected.length > 0 || graceElapsed)) {
        break;
      }
    } else {
      containerStoppedAt = null;
    }

    await sleep(POLL_MS);
  }

  // Final drain after loop
  const tail = drainOutboundBatch(agentGroupId, sessionId, delivery, collectedIds);
  collected.push(...tail);

  log.info('Worker outbound collection finished', {
    sessionId,
    count: collected.length,
    timedOut: Date.now() >= deadline,
  });

  return collected;
}

function drainOutboundBatch(
  agentGroupId: string,
  sessionId: string,
  delivery: WorkerJobRequest['delivery'],
  skipIds: Set<string>,
): WorkerCollectedOutbound[] {
  const results: WorkerCollectedOutbound[] = [];
  const outDb = openOutboundDb(agentGroupId, sessionId);
  const inDb = openInboundDb(agentGroupId, sessionId);

  try {
    migrateDeliveredTable(inDb);
    const delivered = getDeliveredIds(inDb);
    const due = getDueOutboundMessages(outDb).filter((m) => !delivered.has(m.id) && !skipIds.has(m.id));

    for (const msg of due) {
      if (msg.kind === 'system' || msg.channel_type === 'agent') {
        markDelivered(inDb, msg.id, null);
        continue;
      }
      if (!matchesDelivery(msg, delivery)) continue;

      let content: Record<string, unknown>;
      try {
        content = JSON.parse(msg.content) as Record<string, unknown>;
      } catch {
        content = { raw: msg.content };
      }

      const declaredFiles = Array.isArray(content.files) ? (content.files as string[]) : [];
      const fileBuffers = declaredFiles.length
        ? readOutboxFiles(agentGroupId, sessionId, msg.id, declaredFiles)
        : undefined;

      results.push({
        id: msg.id,
        kind: msg.kind,
        channel_type: msg.channel_type,
        platform_id: msg.platform_id,
        thread_id: msg.thread_id,
        content,
        files: fileBuffers ? encodeFiles(fileBuffers) : undefined,
      });

      markDelivered(inDb, msg.id, null);
      if (declaredFiles.length > 0) {
        clearOutbox(agentGroupId, sessionId, msg.id);
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }

  return results;
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

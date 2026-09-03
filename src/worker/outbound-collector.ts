import {
  getDeliveredIds,
  getDueOutboundMessages,
  markDelivered,
  migrateDeliveredTable,
} from '../db/session-db.js';
import { log } from '../log.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from '../session-manager.js';
import { isContainerRunning } from '../container-runner.js';
import type { WorkerCollectedOutbound, WorkerDelivery } from './types.js';
import { handleKnowledgeSystemMessage } from './knowledge-actions.js';

const POLL_MS = 1000;
const POST_STOP_GRACE_MS = 2000;

function matchesDelivery(
  msg: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
  delivery: WorkerDelivery,
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
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  delivery: WorkerDelivery;
  timeoutMs: number;
}

/**
 * Poll outbound.db until a user-facing message is collected for the job's
 * delivery address, the container exits without replying, or timeoutMs elapses.
 * Returns as soon as outbound is ready; the container keeps running for later
 * messages (any further outbounds are picked up by a subsequent job).
 */
export async function collectOutboundMessages(opts: CollectOutboundOptions): Promise<WorkerCollectedOutbound[]> {
  const { workspaceId, agentGroupId, sessionId, delivery, timeoutMs } = opts;
  const collected: WorkerCollectedOutbound[] = [];
  const collectedIds = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let containerStoppedAt: number | null = null;

  while (Date.now() < deadline) {
    const batch = await drainOutboundBatch(workspaceId, agentGroupId, sessionId, delivery, collectedIds);
    for (const msg of batch) {
      collected.push(msg);
      collectedIds.add(msg.id);
    }

    if (collected.length > 0) {
      break;
    }

    if (!isContainerRunning(sessionId)) {
      if (containerStoppedAt === null) {
        containerStoppedAt = Date.now();
      } else if (Date.now() - containerStoppedAt >= POST_STOP_GRACE_MS) {
        break;
      }
    } else {
      containerStoppedAt = null;
    }

    await sleep(POLL_MS);
  }

  if (collected.length === 0) {
    const tail = await drainOutboundBatch(workspaceId, agentGroupId, sessionId, delivery, collectedIds);
    collected.push(...tail);
  }

  log.info('Worker outbound collection finished', {
    sessionId,
    count: collected.length,
    timedOut: Date.now() >= deadline,
  });

  return collected;
}

async function drainOutboundBatch(
  workspaceId: string,
  agentGroupId: string,
  sessionId: string,
  delivery: WorkerDelivery,
  skipIds: Set<string>,
): Promise<WorkerCollectedOutbound[]> {
  const results: WorkerCollectedOutbound[] = [];
  const outDb = openOutboundDb(agentGroupId, sessionId);
  const inDb = openInboundDb(agentGroupId, sessionId);

  try {
    migrateDeliveredTable(inDb);
    const delivered = getDeliveredIds(inDb);
    const due = getDueOutboundMessages(outDb).filter((m) => !delivered.has(m.id) && !skipIds.has(m.id));

    for (const msg of due) {
      if (msg.kind === 'system' || msg.channel_type === 'agent') {
        // Handle knowledge_request before marking delivered so the container
        // MCP tool can receive a knowledge_response on inbound.db.
        if (msg.kind === 'system') {
          try {
            await handleKnowledgeSystemMessage({
              workspaceId,
              agentGroupId,
              sessionId,
              rawContent: msg.content,
            });
          } catch (err) {
            log.error('Failed handling system knowledge action', { sessionId, msgId: msg.id, err });
          }
        }
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

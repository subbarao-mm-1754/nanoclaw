import { log } from '../log.js';
import { workerWorkspacePaths } from '../worker/workspace-store.js';
import { applyMemoryPatch, deliverOutboundMessage } from './delivery.js';
import { getConversation } from './store/conversations.js';
import {
  claimNextInbound,
  deleteMessages,
  insertOutboundMessage,
  updateMessageStatus,
} from './store/messages.js';
import { processMessageOnWorker } from './worker-client.js';
import type { WorkerProcessMessageRequest } from '../worker/types.js';
import { beginHttpDelivery, endHttpDelivery } from './http-channel.js';

let processing = false;
let interval: ReturnType<typeof setInterval> | null = null;

function newJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function processOneInbound(): Promise<boolean> {
  const inbound = claimNextInbound();
  if (!inbound) return false;

  const conversation = inbound.conversation_id ? getConversation(inbound.conversation_id) : null;
  if (!conversation) {
    updateMessageStatus(inbound.id, 'failed', { error: 'Conversation not found' });
    return true;
  }

  const jobId = newJobId();
  updateMessageStatus(inbound.id, 'processing', { worker_job_id: jobId });

  const content = JSON.parse(inbound.content_json) as Record<string, unknown>;
  const payload: WorkerProcessMessageRequest = {
    job_id: jobId,
    workspace_id: conversation.workspace_id,
    session: {
      id: conversation.session_id,
      agent_group_id: conversation.agent_group_id,
    },
    delivery: {
      channel_type: inbound.channel_type,
      platform_id: inbound.platform_id,
      thread_id: inbound.thread_id,
      display_name: inbound.sender_display_name ?? conversation.display_name ?? undefined,
    },
    inbound: {
      id: inbound.id,
      kind: inbound.kind,
      timestamp: inbound.created_at,
      content,
      sender: inbound.sender_id
        ? { id: inbound.sender_id, display_name: inbound.sender_display_name ?? undefined }
        : undefined,
    },
  };

  try {
    const result = await processMessageOnWorker(payload);
    updateMessageStatus(inbound.id, 'processing', {
      worker_job_id: jobId,
      worker_status: result.status,
    });

    if (result.status !== 'completed') {
      updateMessageStatus(inbound.id, 'failed', {
        worker_job_id: jobId,
        worker_status: result.status,
        error: result.error || result.detail || `Worker status: ${result.status}`,
      });
      return true;
    }

    const outboundIds: string[] = [];
    if (inbound.channel_type === 'http') {
      beginHttpDelivery({
        inboundId: inbound.id,
        conversationId: conversation.id,
        workerJobId: jobId,
      });
    }
    try {
      for (const out of result.outbound ?? []) {
        const outbound = insertOutboundMessage({
          id: out.id,
          channel_type: out.channel_type ?? inbound.channel_type,
          platform_id: out.platform_id ?? inbound.platform_id,
          thread_id: out.thread_id ?? inbound.thread_id,
          conversation_id: conversation.id,
          kind: out.kind,
          content: out.content,
          files: out.files,
          worker_job_id: jobId,
        });
        outboundIds.push(outbound.id);

        await deliverOutboundMessage(outbound);
        updateMessageStatus(outbound.id, 'delivered');
      }
    } finally {
      if (inbound.channel_type === 'http') {
        endHttpDelivery();
      }
    }

    if (result.memory_patch) {
      const paths = workerWorkspacePaths(conversation.workspace_id);
      applyMemoryPatch(paths.group_dir, result.memory_patch);
    }

    deleteMessages([inbound.id, ...outboundIds]);
    log.info('Gateway processed inbound message', {
      inboundId: inbound.id,
      jobId,
      outboundCount: outboundIds.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateMessageStatus(inbound.id, 'failed', { worker_job_id: jobId, error: message });
    log.error('Gateway failed to process inbound message', { inboundId: inbound.id, jobId, err });
  }

  return true;
}

async function tick(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (await processOneInbound()) {
      // Drain queue one message at a time.
    }
  } finally {
    processing = false;
  }
}

export function startMessageProcessor(intervalMs: number): void {
  if (interval) return;
  interval = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
  log.info('Gateway message processor started', { intervalMs });
}

export function stopMessageProcessor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

/** @internal Test hook — process one pending inbound synchronously. */
export async function processNextPendingInbound(): Promise<void> {
  await processOneInbound();
}

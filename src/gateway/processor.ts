import { log } from '../log.js';
import { sessionInboundMessageId } from '../session-message-id.js';
import {
  ensureWorkspaceOnWorker,
  invalidateWorkerWorkspaceCache,
  isWorkerWorkspaceMissingError,
} from './agent-service.js';
import { getConversation } from './store/conversations.js';
import {
  claimNextInbound,
  deleteMessages,
  updateMessageStatus,
} from './store/messages.js';
import { processMessageOnWorker } from './worker-client.js';
import type { WorkerProcessMessageRequest } from '../worker/types.js';

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

  try {
    const { ensureOrchestrationRunForUserMessage, extraDestinationsForWorkspace } =
      await import('./orchestration/index.js');
    const goalText =
      typeof content.text === 'string' ? content.text : JSON.stringify(content);
    await ensureOrchestrationRunForUserMessage({
      workspaceId: conversation.workspace_id,
      conversationId: conversation.id,
      sessionId: conversation.session_id,
      goalText,
    });

    const payload: WorkerProcessMessageRequest = {
      job_id: jobId,
      workspace_id: conversation.workspace_id,
      conversation_id: conversation.id,
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
      extra_destinations: extraDestinationsForWorkspace(conversation.workspace_id),
      inbound: {
        id: sessionInboundMessageId(inbound.id, conversation.agent_group_id),
        kind: inbound.kind,
        timestamp: inbound.created_at,
        content,
        sender: inbound.sender_id
          ? { id: inbound.sender_id, display_name: inbound.sender_display_name ?? undefined }
          : undefined,
      },
    };

    await ensureWorkspaceOnWorker(conversation.workspace_id);

    let result;
    try {
      result = await processMessageOnWorker(payload);
    } catch (err) {
      if (!isWorkerWorkspaceMissingError(err)) throw err;
      log.debug('Worker workspace missing on disk; forcing rematerialize', {
        workspaceId: conversation.workspace_id,
        err,
      });
      invalidateWorkerWorkspaceCache(conversation.workspace_id);
      await ensureWorkspaceOnWorker(conversation.workspace_id, { force: true });
      result = await processMessageOnWorker(payload);
    }

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

    // Channel traffic: Worker returns after wake; continuous collector pushes
    // outbound to Gateway when ready. Keep inbound in `processing` until then
    // (callback marks delivered + deletes). If Worker still returned outbound
    // inline (builder/async path shouldn't hit here), ignore — collector owns delivery.
    //
    // If the agent never replies, inbound stays processing until a later cleanup;
    // that matches waiting for a long Ollama turn.
    log.info('Gateway woken worker for inbound message', {
      inboundId: inbound.id,
      jobId,
      sessionId: conversation.session_id,
      detail: result.detail,
    });

    // Duplicate / no-op wakes can complete with no collector activity — clear inbound.
    if (result.detail?.includes('Duplicate platform message')) {
      deleteMessages([inbound.id]);
    }
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

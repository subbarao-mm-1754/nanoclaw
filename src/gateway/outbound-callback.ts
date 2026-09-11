import { workerWorkspacePaths } from '../worker/workspace-store.js';
import type { WorkerOutboundCallbackPayload } from '../worker/types.js';
import { log } from '../log.js';
import { applyMemoryPatch, deliverOutboundMessage } from './delivery.js';
import { beginHttpDelivery, endHttpDelivery } from './http-channel.js';
import { handleBuilderOutboundStream } from './builder/service.js';
import { captureBrowserSessionsFromMemoryPatch } from './store/browser-sessions.js';
import {
  findConversationBySessionId,
  getConversation,
} from './store/conversations.js';
import {
  deleteMessages,
  findLatestProcessingInbound,
  insertOutboundMessage,
  updateMessageStatus,
} from './store/messages.js';
import { invalidateWorkerWorkspaceCache } from './agent-service.js';

/**
 * Handle continuous collector pushes from the Worker.
 * Delivers chat outbound to the channel as soon as the agent writes them —
 * independent of the original process-message request lifetime.
 */
export async function handleWorkerOutboundCallback(
  payload: WorkerOutboundCallbackPayload,
): Promise<{ delivered: number }> {
  if (payload.build_job_id) {
    const streamed = await handleBuilderOutboundStream({
      build_job_id: payload.build_job_id,
      job_id: payload.job_id,
      outbound: payload.outbound ?? [],
    });
    if (payload.memory_patch) {
      try {
        const paths = workerWorkspacePaths(payload.workspace_id);
        applyMemoryPatch(paths.group_dir, payload.memory_patch);
        captureBrowserSessionsFromMemoryPatch(payload.workspace_id, payload.memory_patch);
      } catch (err) {
        log.warn('Failed applying builder collector memory patch', {
          workspaceId: payload.workspace_id,
          buildJobId: payload.build_job_id,
          err,
        });
      }
    }
    return streamed;
  }

  const conversation =
    (payload.conversation_id ? getConversation(payload.conversation_id) : null) ??
    findConversationBySessionId(payload.session_id);

  if (!conversation) {
    log.warn('Outbound callback with unknown conversation/session', {
      sessionId: payload.session_id,
      conversationId: payload.conversation_id,
      outboundCount: payload.outbound?.length ?? 0,
    });
    return { delivered: 0 };
  }

  const outbound = payload.outbound ?? [];
  const jobId = payload.job_id ?? `collector-${payload.session_id}`;
  const deliveredIds: string[] = [];

  const processingInbound = findLatestProcessingInbound(conversation.id);
  const useHttp = conversation.channel_type === 'http' && Boolean(processingInbound);

  if (useHttp && processingInbound) {
    beginHttpDelivery({
      inboundId: processingInbound.id,
      conversationId: conversation.id,
      workerJobId: jobId,
    });
  }

  try {
    for (const out of outbound) {
      const channelType = out.channel_type ?? conversation.channel_type;
      const platformId = out.platform_id ?? conversation.platform_id;
      const threadId =
        out.thread_id !== undefined ? out.thread_id : conversation.thread_id;

      const row = insertOutboundMessage({
        id: out.id,
        channel_type: channelType,
        platform_id: platformId,
        thread_id: threadId,
        conversation_id: conversation.id,
        kind: out.kind,
        content: out.content,
        files: out.files,
        worker_job_id: jobId,
      });

      try {
        await deliverOutboundMessage(row);
        updateMessageStatus(row.id, 'delivered');
        deliveredIds.push(row.id);
      } catch (err) {
        updateMessageStatus(row.id, 'failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        log.error('Gateway failed delivering collector outbound', {
          messageId: row.id,
          sessionId: payload.session_id,
          err,
        });
      }
    }
  } finally {
    if (useHttp) endHttpDelivery();
  }

  if (processingInbound && deliveredIds.length > 0) {
    updateMessageStatus(processingInbound.id, 'delivered', { worker_status: 'completed' });
    deleteMessages([processingInbound.id, ...deliveredIds]);
  } else if (deliveredIds.length > 0) {
    deleteMessages(deliveredIds);
  }

  if (payload.memory_patch) {
    try {
      const paths = workerWorkspacePaths(payload.workspace_id);
      applyMemoryPatch(paths.group_dir, payload.memory_patch);
      const captured = captureBrowserSessionsFromMemoryPatch(
        payload.workspace_id,
        payload.memory_patch,
      );
      if (captured > 0) {
        invalidateWorkerWorkspaceCache(payload.workspace_id);
        log.info('Gateway captured browser session updates from collector memory patch', {
          workspaceId: payload.workspace_id,
          count: captured,
        });
      }
    } catch (err) {
      log.warn('Failed applying collector memory patch', {
        workspaceId: payload.workspace_id,
        err,
      });
    }
  }

  log.info('Gateway handled worker outbound callback', {
    sessionId: payload.session_id,
    conversationId: conversation.id,
    delivered: deliveredIds.length,
  });

  return { delivered: deliveredIds.length };
}

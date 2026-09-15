/**
 * Gateway-side agent-to-agent routing for orchestrators.
 * Worker pushes channel_type=agent outbound; we wake the target workspace.
 */
import { generateId } from '../auth.js';
import { log } from '../../log.js';
import { sessionInboundMessageId } from '../../session-message-id.js';
import {
  ensureWorkspaceOnWorker,
  invalidateWorkerWorkspaceCache,
  isWorkerWorkspaceMissingError,
} from '../agent-service.js';
import { getWorkspace, getWorkspaceByAgentGroupId } from '../store/workspaces.js';
import { processMessageOnWorker } from '../worker-client.js';
import type { WorkerCollectedOutbound } from '../../worker/types.js';
import { isMultiAgentOrchestrationEnabled } from './config.js';
import {
  appendOrchestrationEvent,
  createOrchestrationRun,
  getActiveOrchestrationRun,
  getOrchestratorGraph,
  updateOrchestrationRun,
} from './store.js';

function specialistSessionId(orchestratorSessionId: string, memberWorkspaceId: string): string {
  return `sess-orch-${orchestratorSessionId}-${memberWorkspaceId}`.slice(0, 120);
}

export async function routeAgentOutboundMessages(input: {
  sourceWorkspaceId: string;
  sourceSessionId: string;
  sourceAgentGroupId: string;
  conversationId?: string | null;
  outbound: WorkerCollectedOutbound[];
}): Promise<number> {
  if (!isMultiAgentOrchestrationEnabled()) return 0;

  const agentMsgs = input.outbound.filter(
    (m) => m.channel_type === 'agent' && typeof m.platform_id === 'string' && m.platform_id,
  );
  if (agentMsgs.length === 0) return 0;

  let routed = 0;
  for (const msg of agentMsgs) {
    const targetGroupId = msg.platform_id!;
    const target = getWorkspaceByAgentGroupId(targetGroupId);
    if (!target) {
      log.warn('Orchestration A2A: target agent group not found', {
        targetGroupId,
        sourceWorkspaceId: input.sourceWorkspaceId,
        msgId: msg.id,
      });
      continue;
    }

    const text =
      typeof msg.content.text === 'string'
        ? msg.content.text
        : typeof msg.content.raw_text === 'string'
          ? msg.content.raw_text
          : JSON.stringify(msg.content);

    const sourceWs = getWorkspace(input.sourceWorkspaceId);
    const sessionId = specialistSessionId(input.sourceSessionId, target.workspace_id);
    const inboundId = sessionInboundMessageId(msg.id, target.agent_group_id);

    // Track run state on the orchestrator side.
    if (sourceWs?.agent_kind === 'orchestrator') {
      let run = getActiveOrchestrationRun(sourceWs.workspace_id, input.conversationId);
      if (!run) {
        const graph = getOrchestratorGraph(sourceWs.workspace_id);
        run = createOrchestrationRun({
          orchestrator_workspace_id: sourceWs.workspace_id,
          conversation_id: input.conversationId,
          current_node: graph?.entry ?? null,
          goal: text.slice(0, 500),
        });
      }
      appendOrchestrationEvent(run.id, 'delegate', {
        to_workspace_id: target.workspace_id,
        to_agent_group_id: target.agent_group_id,
        message_id: msg.id,
      });
      updateOrchestrationRun(run.id, {
        status: 'waiting',
        state: {
          last_delegate_to: target.workspace_id,
          last_message_id: msg.id,
        },
      });
    } else if (target.agent_kind === 'orchestrator') {
      const run = getActiveOrchestrationRun(target.workspace_id, input.conversationId);
      if (run) {
        appendOrchestrationEvent(run.id, 'specialist_reply', {
          from_workspace_id: input.sourceWorkspaceId,
          message_id: msg.id,
        });
        updateOrchestrationRun(run.id, { status: 'running' });
      }
    }

    try {
      await ensureWorkspaceOnWorker(target.workspace_id);
      const { extraDestinationsForWorkspace } = await import('./destinations.js');
      const payload = {
        job_id: generateId('a2a'),
        workspace_id: target.workspace_id,
        conversation_id: input.conversationId ?? undefined,
        session: {
          id: sessionId,
          agent_group_id: target.agent_group_id,
        },
        delivery: {
          // Reply path back to source agent.
          channel_type: 'agent',
          platform_id: input.sourceAgentGroupId,
          thread_id: null,
          name: 'orchestrator',
          display_name: sourceWs?.name ?? 'orchestrator',
        },
        extra_destinations: extraDestinationsForWorkspace(target.workspace_id),
        inbound: {
          id: inboundId,
          kind: msg.kind || 'chat',
          timestamp: new Date().toISOString(),
          content: {
            text,
            sender: sourceWs?.name ?? 'orchestrator',
            senderId: `agent:${input.sourceAgentGroupId}`,
          },
          sender: {
            id: `agent:${input.sourceAgentGroupId}`,
            display_name: sourceWs?.name ?? 'orchestrator',
          },
        },
        options: {
          run_container: true,
          wait_for_turn: false,
          wait_for_outbound: false,
        },
      };

      try {
        await processMessageOnWorker(payload);
      } catch (err) {
        if (!isWorkerWorkspaceMissingError(err)) throw err;
        invalidateWorkerWorkspaceCache(target.workspace_id);
        await ensureWorkspaceOnWorker(target.workspace_id, { force: true });
        await processMessageOnWorker(payload);
      }
      routed++;
    } catch (err) {
      log.error('Orchestration A2A route failed', {
        msgId: msg.id,
        targetWorkspaceId: target.workspace_id,
        err,
      });
    }
  }

  return routed;
}

/** Start (or refresh) an orchestration run when a user messages an orchestrator. */
export function ensureOrchestrationRunForUserMessage(input: {
  workspaceId: string;
  conversationId: string;
  goalText: string;
}): void {
  if (!isMultiAgentOrchestrationEnabled()) return;
  const ws = getWorkspace(input.workspaceId);
  if (!ws || ws.agent_kind !== 'orchestrator') return;

  const existing = getActiveOrchestrationRun(input.workspaceId, input.conversationId);
  if (existing) {
    appendOrchestrationEvent(existing.id, 'user_message', { preview: input.goalText.slice(0, 200) });
    return;
  }
  const graph = getOrchestratorGraph(input.workspaceId);
  const run = createOrchestrationRun({
    orchestrator_workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    goal: input.goalText.slice(0, 2000),
    current_node: graph?.entry ?? null,
  });
  appendOrchestrationEvent(run.id, 'started', { goal: input.goalText.slice(0, 200) });
}

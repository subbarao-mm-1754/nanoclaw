/**
 * Gateway-side agent-to-agent routing for orchestrators.
 * Worker pushes channel_type=agent outbound; we wake the target workspace.
 *
 * When a fixed graph is registered, LangGraph (in-process) owns control flow:
 * waits, loop caps, auto-delegate. The orchestrator agent remains the user-facing
 * decision maker but cannot mutate graph/loops/rules.
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
  isLangGraphOrchestrator,
  localNameForMember,
  onOrchestratorDecision,
  onOrchestratorUserMessage,
  onSpecialistReply,
} from './langgraph/index.js';
import { specialistSessionId } from './langgraph/a2a.js';
import {
  appendOrchestrationEvent,
  createOrchestrationRun,
  getActiveOrchestrationRun,
  getOrchestratorGraph,
  parseRunState,
  updateOrchestrationRun,
} from './store.js';

function outboundText(msg: WorkerCollectedOutbound): string {
  return typeof msg.content.text === 'string'
    ? msg.content.text
    : typeof msg.content.raw_text === 'string'
      ? msg.content.raw_text
      : JSON.stringify(msg.content);
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

    const text = outboundText(msg);
    const sourceWs = getWorkspace(input.sourceWorkspaceId);
    const sessionId = specialistSessionId(input.sourceSessionId, target.workspace_id);
    const inboundId = sessionInboundMessageId(msg.id, target.agent_group_id);

    // --- LangGraph hard runner hooks ---
    let skipSoftWake = false;

    if (sourceWs?.agent_kind === 'orchestrator' && isLangGraphOrchestrator(sourceWs.workspace_id)) {
      const members = (
        await import('./store.js')
      ).listOrchestratorMembers(sourceWs.workspace_id);
      const member = members.find((m) => m.member_agent_group_id === target.agent_group_id);
      const branch = member?.local_name || target.name;
      const { getActiveOrchestrationRun, parseRunState } = await import('./store.js');
      const active = getActiveOrchestrationRun(sourceWs.workspace_id, input.conversationId, {
        fallbackToAny: false,
      });
      const lg = active
        ? (parseRunState(active).langgraph as { orchestrator_session_id?: string } | undefined)
        : undefined;
      const decision = await onOrchestratorDecision({
        orchestratorWorkspaceId: sourceWs.workspace_id,
        conversationId: input.conversationId,
        // Never pass nested sess-orch-* ids into the runner — keeps specialist sessions stable.
        orchestratorSessionId: lg?.orchestrator_session_id || input.sourceSessionId,
        branch,
        taskPacket: text,
      });
      if (decision.handled) {
        // Graph consumed (or intentionally ignored) this send_message — do not soft-wake
        // or clobber langgraph state_json.
        skipSoftWake = true;
        routed++;
      }
    } else if (
      target.agent_kind === 'orchestrator' &&
      isLangGraphOrchestrator(target.workspace_id)
    ) {
      const fromName = localNameForMember(target.workspace_id, input.sourceWorkspaceId);
      const { getActiveOrchestrationRun, parseRunState } = await import('./store.js');
      const active = getActiveOrchestrationRun(target.workspace_id, input.conversationId);
      const lg = active
        ? (parseRunState(active).langgraph as { orchestrator_session_id?: string } | undefined)
        : undefined;

      let orchSession = lg?.orchestrator_session_id || '';
      if (!orchSession && input.sourceSessionId.startsWith('sess-orch-')) {
        const rest = input.sourceSessionId.slice('sess-orch-'.length);
        const suffix = `-${input.sourceWorkspaceId}`;
        orchSession = rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : rest;
      }
      if (!orchSession) orchSession = input.sourceSessionId;

      const handled = await onSpecialistReply({
        orchestratorWorkspaceId: target.workspace_id,
        conversationId: input.conversationId,
        orchestratorSessionId: orchSession,
        fromWorkspaceId: input.sourceWorkspaceId,
        fromLocalName: fromName ?? undefined,
        text,
        messageId: msg.id,
        content: msg.content as Record<string, unknown>,
      });
      if (handled) {
        skipSoftWake = true;
        routed++;
      }
    }

    // Soft / legacy run tracking when not fully handled by LangGraph auto-path.
    // CRITICAL: never create/update soft runs for LangGraph orchestrators — that
    // wipes interrupt meta and leaves TripPlanner stuck in A2A loops with no Cliq reply.
    if (sourceWs?.agent_kind === 'orchestrator' && !skipSoftWake) {
      if (isLangGraphOrchestrator(sourceWs.workspace_id)) {
        const soft = getActiveOrchestrationRun(sourceWs.workspace_id, input.conversationId, {
          fallbackToAny: false,
        });
        if (soft) {
          const st = parseRunState(soft);
          const engine = (st.langgraph as { engine?: string } | undefined)?.engine;
          if (engine !== 'langgraph') {
            updateOrchestrationRun(soft.id, { status: 'completed' });
            appendOrchestrationEvent(soft.id, 'completed', {
              reason: 'close_soft_under_langgraph',
              note: 'Soft run was stealing the conversation from LangGraph',
            });
          }
        }
        // Fall through to A2A wake below without soft DB tracking.
      } else {
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
            ...parseRunState(run),
            last_delegate_to: target.workspace_id,
            last_message_id: msg.id,
          },
        });
      }
    } else if (target.agent_kind === 'orchestrator' && !skipSoftWake) {
      if (!isLangGraphOrchestrator(target.workspace_id)) {
        const run = getActiveOrchestrationRun(target.workspace_id, input.conversationId);
        if (run) {
          appendOrchestrationEvent(run.id, 'specialist_reply', {
            from_workspace_id: input.sourceWorkspaceId,
            message_id: msg.id,
          });
          updateOrchestrationRun(run.id, { status: 'running' });
        }
      }
    }

    if (skipSoftWake) continue;

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
          channel_type: 'agent' as const,
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

/**
 * Start (or refresh) an orchestration run when a user messages an orchestrator.
 * LangGraph-backed when a fixed graph exists; otherwise soft DB tracking only.
 */
export async function ensureOrchestrationRunForUserMessage(input: {
  workspaceId: string;
  conversationId: string;
  sessionId?: string;
  goalText: string;
}): Promise<void> {
  if (!isMultiAgentOrchestrationEnabled()) return;
  const ws = getWorkspace(input.workspaceId);
  if (!ws || ws.agent_kind !== 'orchestrator') return;

  if (isLangGraphOrchestrator(input.workspaceId)) {
    await onOrchestratorUserMessage({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionId: input.sessionId || `sess-${input.conversationId}`,
      goalText: input.goalText,
    });
    return;
  }

  const existing = getActiveOrchestrationRun(input.workspaceId, input.conversationId);
  if (existing) {
    appendOrchestrationEvent(existing.id, 'user_message', {
      preview: input.goalText.slice(0, 200),
    });
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

/**
 * A2A wake helpers used by the LangGraph runner (same Worker path as soft routing).
 */
import { generateId } from '../../auth.js';
import { log } from '../../../log.js';
import { sessionInboundMessageId } from '../../../session-message-id.js';
import {
  ensureWorkspaceOnWorker,
  invalidateWorkerWorkspaceCache,
  isWorkerWorkspaceMissingError,
} from '../../agent-service.js';
import { getWorkspace, getWorkspaceByAgentGroupId } from '../../store/workspaces.js';
import { processMessageOnWorker } from '../../worker-client.js';
import { extraDestinationsForWorkspace } from '../destinations.js';
import { listOrchestratorMembers } from '../store.js';

export function specialistSessionId(
  orchestratorSessionId: string,
  memberWorkspaceId: string,
): string {
  return `sess-orch-${orchestratorSessionId}-${memberWorkspaceId}`.slice(0, 120);
}

export async function wakeAgentWithText(input: {
  targetWorkspaceId: string;
  sourceWorkspaceId: string;
  sourceAgentGroupId: string;
  sourceSessionId: string;
  conversationId?: string | null;
  text: string;
  inboundMessageId: string;
  /** Destination name shown on the target for replies. */
  replyDestinationName?: string;
}): Promise<boolean> {
  const target = getWorkspace(input.targetWorkspaceId);
  if (!target) {
    log.warn('LangGraph A2A: target workspace missing', {
      targetWorkspaceId: input.targetWorkspaceId,
    });
    return false;
  }

  const sourceWs = getWorkspace(input.sourceWorkspaceId);
  const sessionId = specialistSessionId(input.sourceSessionId, target.workspace_id);
  const inboundId = sessionInboundMessageId(input.inboundMessageId, target.agent_group_id);

  try {
    await ensureWorkspaceOnWorker(target.workspace_id);
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
        name: input.replyDestinationName ?? 'orchestrator',
        display_name: sourceWs?.name ?? 'orchestrator',
      },
      extra_destinations: extraDestinationsForWorkspace(target.workspace_id),
      inbound: {
        id: inboundId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: input.text,
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
    return true;
  } catch (err) {
    log.error('LangGraph A2A wake failed', {
      targetWorkspaceId: target.workspace_id,
      err,
    });
    return false;
  }
}

/** Resolve specialist member by local destination name. */
export function resolveMemberByLocalName(
  orchestratorWorkspaceId: string,
  localName: string,
): { member_workspace_id: string; member_agent_group_id: string; local_name: string } | null {
  const name = localName.trim().toLowerCase();
  const members = listOrchestratorMembers(orchestratorWorkspaceId);
  return members.find((m) => m.local_name === name) ?? null;
}

export function resolveWorkspaceByAgentGroup(agentGroupId: string) {
  return getWorkspaceByAgentGroupId(agentGroupId);
}

/** Wake an agent on a specific session (e.g. orchestrator conversation session). */
export async function wakeWorkspaceSession(input: {
  workspaceId: string;
  sessionId: string;
  agentGroupId: string;
  conversationId?: string | null;
  text: string;
  inboundMessageId: string;
  delivery?: {
    channel_type: string;
    platform_id: string;
    thread_id: string | null;
    display_name?: string;
  };
}): Promise<boolean> {
  const target = getWorkspace(input.workspaceId);
  if (!target) return false;

  try {
    await ensureWorkspaceOnWorker(target.workspace_id);
    const delivery = input.delivery
      ? {
          channel_type: input.delivery.channel_type,
          platform_id: input.delivery.platform_id,
          thread_id: input.delivery.thread_id ?? null,
          display_name: input.delivery.display_name,
        }
      : {
          channel_type: 'agent' as const,
          platform_id: target.agent_group_id,
          thread_id: null as string | null,
          name: 'orchestrator',
          display_name: target.name,
        };

    const payload = {
      job_id: generateId('lgwake'),
      workspace_id: target.workspace_id,
      conversation_id: input.conversationId ?? undefined,
      session: {
        id: input.sessionId,
        agent_group_id: input.agentGroupId || target.agent_group_id,
      },
      delivery,
      extra_destinations: extraDestinationsForWorkspace(target.workspace_id),
      inbound: {
        id: sessionInboundMessageId(input.inboundMessageId, target.agent_group_id),
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: input.text,
          sender: 'system',
          senderId: 'system:langgraph',
        },
        sender: {
          id: 'system:langgraph',
          display_name: 'LangGraph',
        },
      },
      options: {
        run_container: true,
        wait_for_turn: false,
        wait_for_outbound: false,
      },
    };

    try {
      await processMessageOnWorker(payload as Parameters<typeof processMessageOnWorker>[0]);
    } catch (err) {
      if (!isWorkerWorkspaceMissingError(err)) throw err;
      invalidateWorkerWorkspaceCache(target.workspace_id);
      await ensureWorkspaceOnWorker(target.workspace_id, { force: true });
      await processMessageOnWorker(payload as Parameters<typeof processMessageOnWorker>[0]);
    }
    return true;
  } catch (err) {
    log.error('LangGraph session wake failed', { workspaceId: input.workspaceId, err });
    return false;
  }
}

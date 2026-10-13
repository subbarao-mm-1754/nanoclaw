import {
  AUTO_AGENT_ROUTE,
  LAYA_CONFIDENCE_MIN,
  LAYA_PROBABILITY_MIN,
} from '../../config.js';
import { log } from '../../log.js';
import type { Conversation, CustomerMessage, GatewayWorkspace } from '../types.js';
import { isUserFacingWorkspaceId, listUserAgents } from '../store/agent-select.js';
import { setConversationWorkspace } from '../store/conversations.js';
import { getWorkspace } from '../store/workspaces.js';
import { safeLayaChoice } from './laya-client.js';
import {
  clampToLayaTokens,
  estimateLayaTokens,
  formatLayaOptionCriteria,
  LAYA_OPTIONS_TOTAL_TARGET,
  perOptionTokenBudget,
} from './routing-description.js';

/** Keep agent count low so options fit Laya's 176-token shared budget. */
const MAX_AGENTS_PER_CHOICE = 8;
const MAX_MESSAGE_CHARS = 200;

export type AutoRouteResult = {
  conversation: Conversation;
  switched: boolean;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  toAgentName: string | null;
  reason: 'disabled' | 'no_text' | 'solo' | 'stay' | 'switch' | 'laya_failed' | 'low_confidence';
};

function extractUserText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
}

/** Pick ≤20 candidates: always current + master, then newest others. */
export function selectRoutableAgents(
  agents: GatewayWorkspace[],
  currentWorkspaceId: string,
): GatewayWorkspace[] {
  const facing = agents.filter((a) => isUserFacingWorkspaceId(a.workspace_id));
  if (facing.length === 0) return [];

  const byId = new Map(facing.map((a) => [a.workspace_id, a]));
  const selected: GatewayWorkspace[] = [];
  const add = (id: string | undefined) => {
    if (!id) return;
    const a = byId.get(id);
    if (!a || selected.some((s) => s.workspace_id === a.workspace_id)) return;
    selected.push(a);
  };

  add(currentWorkspaceId);
  const master = facing.find((a) => a.is_master);
  add(master?.workspace_id);

  const rest = facing
    .filter((a) => !selected.some((s) => s.workspace_id === a.workspace_id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  for (const a of rest) {
    if (selected.length >= MAX_AGENTS_PER_CHOICE) break;
    selected.push(a);
  }
  return selected;
}

/**
 * Short keys + per-option budgets that fit Laya's shared 176-token options pool.
 */
export function buildLayaAgentCriteria(
  agents: GatewayWorkspace[],
  currentWorkspaceId: string,
): { criteria: Record<string, string>; keyToWorkspaceId: Map<string, string> } {
  const criteria: Record<string, string> = {};
  const keyToWorkspaceId = new Map<string, string>();
  let budget = perOptionTokenBudget(agents.length);

  const fill = (maxTokens: number) => {
    for (const key of Object.keys(criteria)) delete criteria[key];
    keyToWorkspaceId.clear();
    agents.forEach((agent, i) => {
      const key = `a${i}`;
      keyToWorkspaceId.set(key, agent.workspace_id);
      criteria[key] = formatLayaOptionCriteria(
        agent,
        agent.workspace_id === currentWorkspaceId,
        maxTokens,
      );
    });
  };

  fill(budget);

  // Shrink until estimated total is under target (keys + values).
  let guard = 0;
  while (guard++ < 12) {
    const total =
      Object.keys(criteria).reduce((n, k) => n + estimateLayaTokens(k), 0) +
      Object.values(criteria).reduce((n, v) => n + estimateLayaTokens(v), 0);
    if (total <= LAYA_OPTIONS_TOTAL_TARGET) break;
    budget = Math.max(6, budget - 2);
    fill(budget);
  }

  return { criteria, keyToWorkspaceId };
}

/**
 * One Laya stay-or-switch decision. Sticky-binds like `/use` when switching.
 * On failure / low confidence / solo agent → stay.
 */
export async function applyAutoAgentRoute(input: {
  conversation: Conversation;
  inbound: CustomerMessage;
}): Promise<AutoRouteResult> {
  const { conversation, inbound } = input;
  const fromWorkspaceId = conversation.workspace_id;
  const current = getWorkspace(fromWorkspaceId);
  const stay = (
    reason: AutoRouteResult['reason'],
    toName: string | null = current?.name ?? null,
  ): AutoRouteResult => ({
    conversation,
    switched: false,
    fromWorkspaceId,
    toWorkspaceId: fromWorkspaceId,
    toAgentName: toName,
    reason,
  });

  if (!AUTO_AGENT_ROUTE) return stay('disabled');

  const content = (() => {
    try {
      return JSON.parse(inbound.content_json) as unknown;
    } catch {
      return null;
    }
  })();
  const message = extractUserText(content);
  if (!message) return stay('no_text');

  const ownerUserId = current?.owner_user_id;
  if (!ownerUserId) return stay('solo');

  const agents = selectRoutableAgents(listUserAgents(ownerUserId), fromWorkspaceId);
  if (agents.length <= 1) return stay('solo');

  const { criteria, keyToWorkspaceId } = buildLayaAgentCriteria(agents, fromWorkspaceId);
  const state = {
    current: clampToLayaTokens(current?.name ?? 'current', 12),
    message: message.slice(0, MAX_MESSAGE_CHARS),
  };

  const optionsByKey = Object.fromEntries(
    [...keyToWorkspaceId.entries()].map(([key, workspaceId]) => {
      const agent = agents.find((a) => a.workspace_id === workspaceId);
      return [key, { workspaceId, name: agent?.name ?? workspaceId, criteria: criteria[key] }];
    }),
  );

  log.info('Auto agent route: calling Laya', {
    conversationId: conversation.id,
    currentAgent: current?.name ?? fromWorkspaceId,
    currentWorkspaceId: fromWorkspaceId,
    messagePreview: message.slice(0, 120),
    options: optionsByKey,
  });

  const answer = await safeLayaChoice({
    state,
    questionKey: 'agent',
    questions: {
      agent: {
        type: 'choice',
        instructions:
          'Pick the agent for this message. Prefer current if it is a continuation; switch only when another agent clearly owns it.',
        criteria,
      },
    },
  });

  if (!answer) return stay('laya_failed');

  const chosenId = keyToWorkspaceId.get(answer.choice) ?? answer.choice;
  const chosen = agents.find((a) => a.workspace_id === chosenId);
  if (!chosen) {
    log.warn('Auto agent route: Laya chose unknown option', {
      conversationId: conversation.id,
      choiceKey: answer.choice,
      options: optionsByKey,
    });
    return stay('laya_failed');
  }

  const probabilitiesByName = Object.fromEntries(
    Object.entries(answer.probabilities).map(([key, prob]) => {
      const workspaceId = keyToWorkspaceId.get(key) ?? key;
      const agent = agents.find((a) => a.workspace_id === workspaceId);
      return [agent?.name ?? key, Number(prob)];
    }),
  );

  const chosenProb =
    answer.probabilities[answer.choice] ?? answer.probabilities[chosenId] ?? 0;

  if (chosen.workspace_id === fromWorkspaceId) {
    log.info('Auto agent route: recommendation', {
      conversationId: conversation.id,
      decision: 'stay',
      recommendedAgent: chosen.name,
      recommendedWorkspaceId: chosen.workspace_id,
      confidence: answer.confidence,
      probability: chosenProb,
      probabilities: probabilitiesByName,
    });
    return stay('stay', chosen.name);
  }

  if (answer.confidence < LAYA_CONFIDENCE_MIN || chosenProb < LAYA_PROBABILITY_MIN) {
    log.info('Auto agent route: recommendation', {
      conversationId: conversation.id,
      decision: 'stay_low_confidence',
      recommendedAgent: chosen.name,
      recommendedWorkspaceId: chosen.workspace_id,
      currentAgent: current?.name ?? fromWorkspaceId,
      confidence: answer.confidence,
      probability: chosenProb,
      thresholds: {
        confidenceMin: LAYA_CONFIDENCE_MIN,
        probabilityMin: LAYA_PROBABILITY_MIN,
      },
      probabilities: probabilitiesByName,
    });
    return stay('low_confidence');
  }

  const updated = setConversationWorkspace({
    channel_type: conversation.channel_type,
    platform_id: conversation.platform_id,
    thread_id: conversation.thread_id,
    workspace_id: chosen.workspace_id,
    display_name: conversation.display_name ?? undefined,
  });

  log.info('Auto agent route: recommendation', {
    conversationId: conversation.id,
    decision: 'switch',
    fromAgent: current?.name ?? fromWorkspaceId,
    fromWorkspaceId,
    recommendedAgent: chosen.name,
    recommendedWorkspaceId: chosen.workspace_id,
    confidence: answer.confidence,
    probability: chosenProb,
    probabilities: probabilitiesByName,
  });

  return {
    conversation: updated,
    switched: true,
    fromWorkspaceId,
    toWorkspaceId: chosen.workspace_id,
    toAgentName: chosen.name,
    reason: 'switch',
  };
}

export function formatAgentReplyLabel(agentName: string): string {
  return agentName.trim() || 'Agent';
}

/** Prefix channel text so users see which agent replied (when auto-route is on). */
export function labelOutboundText(text: string, agentName: string | null | undefined): string {
  if (!AUTO_AGENT_ROUTE) return text;
  const name = agentName?.trim();
  if (!name || !text.trim()) return text;
  // Avoid double-prefix if already labeled.
  if (text.startsWith(`**${name}**`) || text.startsWith(`[${name}]`)) return text;
  return `**${name}**\n${text}`;
}

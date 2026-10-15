import {
  AUTO_AGENT_ROUTE,
  DECISION_CONFIDENCE_MIN,
  DECISION_HISTORY_CHARS,
  DECISION_HISTORY_MESSAGES,
  DECISION_MAX_AGENTS,
  DECISION_MESSAGE_CHARS,
  DECISION_PROBABILITY_MIN,
} from '../../config.js';
import { log } from '../../log.js';
import type { Conversation, CustomerMessage, GatewayWorkspace } from '../types.js';
import { isUserFacingWorkspaceId, listUserAgents } from '../store/agent-select.js';
import { setConversationWorkspace } from '../store/conversations.js';
import { listRecentConversationMessages } from '../store/messages.js';
import { getWorkspace } from '../store/workspaces.js';
import { safeDecisionChoice } from './decision-client.js';
import {
  clampToDecisionTokens,
  decisionOptionsTotalTarget,
  estimateDecisionTokens,
  formatOptionCriteria,
  perOptionTokenBudget,
} from './routing-description.js';

export type AutoRouteResult = {
  conversation: Conversation;
  switched: boolean;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  toAgentName: string | null;
  reason:
    | 'disabled'
    | 'no_text'
    | 'solo'
    | 'stay'
    | 'switch'
    | 'decision_failed'
    | 'low_confidence';
};

function extractUserText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
}

function extractAgentName(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const name = (content as { agent_name?: unknown }).agent_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Strip channel delivery prefix `**Agent**\n` so history isn't double-labeled. */
function stripAgentLabelPrefix(text: string, agentName: string | null): string {
  if (!agentName) return text;
  const prefixes = [`**${agentName}**\n`, `[${agentName}]\n`, `**${agentName}**: `, `${agentName}: `];
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length).trimStart();
  }
  return text;
}

/** Pick ≤ DECISION_MAX_AGENTS candidates: always current + master, then newest others. */
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
    if (selected.length >= DECISION_MAX_AGENTS) break;
    selected.push(a);
  }
  return selected;
}

/**
 * Short keys + per-option budgets that fit the configured shared options pool.
 */
export function buildAgentCriteria(
  agents: GatewayWorkspace[],
  currentWorkspaceId: string,
): { criteria: Record<string, string>; keyToWorkspaceId: Map<string, string> } {
  const criteria: Record<string, string> = {};
  const keyToWorkspaceId = new Map<string, string>();
  let budget = perOptionTokenBudget(agents.length);
  const target = decisionOptionsTotalTarget();

  const fill = (maxTokens: number) => {
    for (const key of Object.keys(criteria)) delete criteria[key];
    keyToWorkspaceId.clear();
    agents.forEach((agent, i) => {
      const key = `a${i}`;
      keyToWorkspaceId.set(key, agent.workspace_id);
      criteria[key] = formatOptionCriteria(
        agent,
        agent.workspace_id === currentWorkspaceId,
        maxTokens,
      );
    });
  };

  fill(budget);

  // Shrink until estimated total is under target (keys + values).
  let guard = 0;
  while (guard++ < 24) {
    const total =
      Object.keys(criteria).reduce((n, k) => n + estimateDecisionTokens(k), 0) +
      Object.values(criteria).reduce((n, v) => n + estimateDecisionTokens(v), 0);
    if (total <= target) break;
    budget = Math.max(6, budget - Math.max(2, Math.floor(budget * 0.1)));
    fill(budget);
  }

  return { criteria, keyToWorkspaceId };
}

/**
 * Recent turns for the decision model. Assistant lines are labeled with the
 * serving agent name so stay-vs-switch can see who handled the thread.
 */
export function buildRecentHistory(
  conversationId: string,
  excludeMessageId: string,
  currentAgentName?: string | null,
): string | undefined {
  if (DECISION_HISTORY_MESSAGES <= 0 || DECISION_HISTORY_CHARS <= 0) return undefined;

  const recent = listRecentConversationMessages(
    conversationId,
    DECISION_HISTORY_MESSAGES,
    excludeMessageId,
  );
  if (recent.length === 0) return undefined;

  const lines: string[] = [];
  for (const msg of recent) {
    let content: unknown = null;
    try {
      content = JSON.parse(msg.content_json) as unknown;
    } catch {
      content = null;
    }
    let text = extractUserText(content);
    if (!text) continue;

    if (msg.direction === 'inbound') {
      lines.push(`user: ${text}`);
      continue;
    }

    const agentName = extractAgentName(content) ?? currentAgentName?.trim() ?? null;
    text = stripAgentLabelPrefix(text, agentName);
    const speaker = agentName || 'assistant';
    const mark =
      currentAgentName?.trim() &&
      agentName &&
      agentName.toLowerCase() === currentAgentName.trim().toLowerCase()
        ? '*'
        : '';
    lines.push(`${speaker}${mark}: ${text}`);
  }
  if (lines.length === 0) return undefined;

  let joined = lines.join('\n');
  if (joined.length > DECISION_HISTORY_CHARS) {
    joined = `…${joined.slice(-(DECISION_HISTORY_CHARS - 1))}`;
  }
  return joined;
}

/**
 * One stay-or-switch decision via `/v1/systemone` (default model: clef-flash).
 * Sticky-binds like `/use` when switching. On failure / low confidence / solo → stay.
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

  const { criteria, keyToWorkspaceId } = buildAgentCriteria(agents, fromWorkspaceId);
  const currentNameTokens = Math.min(
    48,
    Math.max(12, Math.floor(perOptionTokenBudget(agents.length) / 3)),
  );
  const recent = buildRecentHistory(conversation.id, inbound.id, current?.name);
  const state: Record<string, string> = {
    current: clampToDecisionTokens(current?.name ?? 'current', currentNameTokens),
    message: message.slice(0, DECISION_MESSAGE_CHARS),
  };
  if (recent) state.recent = recent;

  log.info('Auto agent route: deciding', {
    conversationId: conversation.id,
    currentAgent: current?.name ?? fromWorkspaceId,
    agentCount: agents.length,
  });

  const answer = await safeDecisionChoice({
    state,
    questionKey: 'agent',
    questions: {
      agent: {
        type: 'choice',
        instructions:
          'Pick the agent whose specialty best matches state.message. state.current (* in recent) is the bound agent — keep it for same-topic continuations, but switch when the new message clearly matches another agent\'s specialty (e.g. contacts/invoices vs news).',
        criteria,
      },
    },
  });

  if (!answer) return stay('decision_failed');

  const chosenId = keyToWorkspaceId.get(answer.choice) ?? answer.choice;
  const chosen = agents.find((a) => a.workspace_id === chosenId);
  if (!chosen) {
    log.warn('Auto agent route: unknown option', {
      conversationId: conversation.id,
      choiceKey: answer.choice,
    });
    return stay('decision_failed');
  }

  const chosenProb =
    answer.probabilities[answer.choice] ?? answer.probabilities[chosenId] ?? 0;

  if (chosen.workspace_id === fromWorkspaceId) {
    log.info('Auto agent route: stay', {
      conversationId: conversation.id,
      agent: chosen.name,
      confidence: answer.confidence,
      probability: chosenProb,
    });
    return stay('stay', chosen.name);
  }

  if (
    answer.confidence < DECISION_CONFIDENCE_MIN ||
    chosenProb < DECISION_PROBABILITY_MIN
  ) {
    log.info('Auto agent route: stay (low confidence)', {
      conversationId: conversation.id,
      currentAgent: current?.name ?? fromWorkspaceId,
      suggestedAgent: chosen.name,
      confidence: answer.confidence,
      probability: chosenProb,
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

  log.info('Auto agent route: switch', {
    conversationId: conversation.id,
    fromAgent: current?.name ?? fromWorkspaceId,
    toAgent: chosen.name,
    confidence: answer.confidence,
    probability: chosenProb,
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

import type { GatewayUser, GatewayWorkspace } from '../types.js';
import { listAgentsForUser } from './agents.js';
import { findConversation } from './conversations.js';

export function listUserAgents(userId: string): GatewayWorkspace[] {
  return listAgentsForUser(userId).filter((w) => !w.workspace_id.startsWith('ws-builder-'));
}

export class AgentResolveError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentResolveError';
  }
}

/** Resolve by workspace id, exact name, or unique partial name/id match. */
export function resolveUserAgent(userId: string, query: string): GatewayWorkspace {
  const q = query.trim();
  if (!q) throw new AgentResolveError('Usage: `/use <agent name or workspace id>`');

  const agents = listUserAgents(userId);
  if (agents.length === 0) {
    throw new AgentResolveError('You have no agents yet. Create one with `/build …`.', 404);
  }

  const lower = q.toLowerCase();
  const exactId = agents.find((a) => a.workspace_id.toLowerCase() === lower);
  if (exactId) return exactId;

  const exactName = agents.filter((a) => a.name.toLowerCase() === lower);
  if (exactName.length === 1) return exactName[0]!;
  if (exactName.length > 1) {
    throw new AgentResolveError(
      `Multiple agents named "${q}". Use a workspace id:\n${formatAgentList(exactName)}`,
    );
  }

  const partial = agents.filter(
    (a) => a.name.toLowerCase().includes(lower) || a.workspace_id.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new AgentResolveError(
      `Ambiguous "${q}". Matches:\n${formatAgentList(partial)}\nUse a fuller name or workspace id.`,
    );
  }

  throw new AgentResolveError(
    `No agent matching "${q}". Your agents:\n${formatAgentList(agents)}`,
    404,
  );
}

export function formatAgentList(
  agents: GatewayWorkspace[],
  currentWorkspaceId?: string | null,
): string {
  if (agents.length === 0) return '(none)';
  return agents
    .map((a, i) => {
      const markers: string[] = [];
      if (a.is_default) markers.push('default');
      if (currentWorkspaceId && a.workspace_id === currentWorkspaceId) markers.push('active in this chat');
      const suffix = markers.length ? ` [${markers.join(', ')}]` : '';
      return `${i + 1}. ${a.name}${suffix}\n   id: ${a.workspace_id}`;
    })
    .join('\n');
}

export function formatAgentsForUser(
  user: GatewayUser,
  channelType: string,
  platformId: string,
  threadId: string | null,
): string {
  const agents = listUserAgents(user.id);
  const conv = findConversation(channelType, platformId, threadId);
  const current = conv?.workspace_id ?? null;

  if (agents.length === 0) {
    return 'You have no user agents yet. Create one with `/build <description>`.';
  }

  return [
    'Your agents:',
    formatAgentList(agents, current),
    '',
    'Switch this chat with `/use <name or id>`.',
  ].join('\n');
}

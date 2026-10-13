import { USER_MASTER_AGENT_NAME } from '../../config.js';
import { MASTER_ROUTING_DESCRIPTION } from '../agent-route/routing-description.js';
import type { GatewayWorkspace } from '../types.js';
import { createAgentRecord } from './agents.js';
import { getMasterWorkspaceForUser } from './workspaces.js';

function masterAgentFiles(name: string): Array<{ path: string; content: string }> {
  return [
    {
      path: 'CLAUDE.local.md',
      content: [
        `# ${name}`,
        '',
        'You are the user\'s general-purpose assistant (master agent).',
        'Handle anything that is not routed to a specialist agent:',
        'answering questions, researching the web, summarizing, drafting,',
        'and other day-to-day AI tasks.',
        '',
        'Be concise, accurate, and practical. When a task clearly belongs',
        'to a specialist the user has built, suggest switching with `/use`.',
        '',
      ].join('\n'),
    },
  ];
}

/**
 * Return the user's master agent, creating it if missing.
 * Only this helper sets `is_master` — /build, Studio create, and API create
 * never mark other agents as master.
 */
export function ensureMasterAgentForUser(userId: string): GatewayWorkspace {
  const existing = getMasterWorkspaceForUser(userId);
  if (existing) return existing;

  const name = USER_MASTER_AGENT_NAME;
  return createAgentRecord({
    name,
    owner_user_id: userId,
    folder: 'master-agent',
    cli_scope: 'group',
    is_default: true,
    is_master: true,
    routing_description: `${name} — ${MASTER_ROUTING_DESCRIPTION}`,
    files: masterAgentFiles(name),
  });
}

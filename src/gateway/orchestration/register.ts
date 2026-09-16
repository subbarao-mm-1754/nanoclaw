/**
 * Register an orchestrator (+ specialists) from a completed build fence.
 */
import { createAgent } from '../agent-service.js';
import { log } from '../../log.js';
import { listUserAgents, resolveUserAgent } from '../store/agent-select.js';
import { getAgentForUser } from '../store/agents.js';
import type { GatewayAgent, GatewayAgentFile, ParsedBuildResult } from '../types.js';
import { composeOrchestratorFiles } from './compose.js';
import { isMultiAgentOrchestrationEnabled } from './config.js';
import { replaceOrchestratorMembers, saveOrchestratorGraph } from './store.js';
import type { ParsedSpecialistSpec } from './types.js';

export class OrchestratorRegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorRegisterError';
  }
}

function normalizeLocalName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export async function registerOrchestratorFromBuild(input: {
  userId: string;
  parsed: ParsedBuildResult;
  files: GatewayAgentFile[];
}): Promise<{ orchestrator: GatewayAgent; specialists: GatewayAgent[]; createdNames: string[] }> {
  if (!isMultiAgentOrchestrationEnabled()) {
    throw new OrchestratorRegisterError(
      'Multi-agent orchestration is disabled. Set MULTI_AGENT_ORCHESTRATION_ENABLED=true (or gateway setting) to enable.',
    );
  }

  const specialists = input.parsed.specialists ?? [];
  if (specialists.length === 0) {
    throw new OrchestratorRegisterError(
      'Orchestrator builds require a non-empty `specialists` array (create and/or reuse agents).',
    );
  }

  const orchName = input.parsed.agent_name?.trim() || 'Orchestrator';
  const composedFiles = composeOrchestratorFiles({
    files: input.files,
    specialists,
    graph: input.parsed.graph,
  });

  const orchestrator = await createAgent({
    name: orchName,
    owner_user_id: input.userId,
    files: composedFiles,
    is_default: false,
    agent_kind: 'orchestrator',
  });

  const members: Array<{
    member_workspace_id: string;
    member_agent_group_id: string;
    local_name: string;
    role?: string | null;
  }> = [];
  const created: GatewayAgent[] = [];
  const createdNames: string[] = [];
  const usedNames = new Set<string>();

  for (const spec of specialists) {
    const localName = normalizeLocalName(spec.name || spec.agent_name || 'specialist');
    if (!localName) {
      throw new OrchestratorRegisterError('Specialist is missing a usable `name`.');
    }
    if (usedNames.has(localName)) {
      throw new OrchestratorRegisterError(`Duplicate specialist destination name "${localName}".`);
    }
    usedNames.add(localName);

    let member: GatewayAgent;
    if (spec.action === 'reuse') {
      const query = spec.workspace_id?.trim() || spec.reuse_name?.trim() || spec.agent_name?.trim();
      if (!query) {
        throw new OrchestratorRegisterError(
          `Specialist "${localName}" action=reuse needs workspace_id or reuse_name.`,
        );
      }
      const existing = resolveUserAgent(input.userId, query);
      const full = getAgentForUser(existing.workspace_id, input.userId);
      if (!full) {
        throw new OrchestratorRegisterError(`Could not load reused agent "${query}".`);
      }
      member = full;
    } else {
      const files = spec.files ?? [];
      if (files.length === 0) {
        throw new OrchestratorRegisterError(
          `Specialist "${localName}" action=create needs files (at least CLAUDE.local.md).`,
        );
      }
      const agentName = spec.agent_name?.trim() || spec.name || `Specialist ${localName}`;
      member = await createAgent({
        name: agentName,
        owner_user_id: input.userId,
        files,
        is_default: false,
        agent_kind: 'agent',
      });
      created.push(member);
      createdNames.push(agentName);
    }

    members.push({
      member_workspace_id: member.workspace_id,
      member_agent_group_id: member.agent_group_id,
      local_name: localName,
      role: spec.role ?? null,
    });
  }

  replaceOrchestratorMembers(orchestrator.workspace_id, members);
  if (input.parsed.graph) {
    saveOrchestratorGraph(orchestrator.workspace_id, input.parsed.graph);
    const { invalidateCompiledGraph } = await import('./langgraph/index.js');
    invalidateCompiledGraph(orchestrator.workspace_id);
  }

  log.info('Registered orchestrator with specialists', {
    orchestratorId: orchestrator.workspace_id,
    memberCount: members.length,
    createdCount: created.length,
  });

  return { orchestrator, specialists: created, createdNames };
}

/** Summarize a proposal for Cliq confirmation (before /register). */
export function formatOrchestratorProposal(parsed: ParsedBuildResult): string {
  const name = parsed.agent_name?.trim() || 'Orchestrator';
  const specs = parsed.specialists ?? [];
  const lines = [
    `Proposed **orchestrator** "${name}" with ${specs.length} specialist(s):`,
    ...specs.map((s: ParsedSpecialistSpec, i: number) => {
      const action = s.action === 'reuse' ? 'reuse existing' : 'create new';
      const target = s.reuse_name || s.workspace_id || s.agent_name || s.name;
      return `${i + 1}. \`${s.name}\` — ${action}${target ? ` (${target})` : ''}${s.role ? `: ${s.role}` : ''}`;
    }),
  ];
  if (parsed.graph?.nodes?.length) {
    lines.push(
      '',
      `Graph: ${parsed.graph.nodes.length} node(s), entry \`${parsed.graph.entry ?? parsed.graph.nodes[0]?.id}\`.`,
    );
  }
  lines.push(
    '',
    'If this looks right, send `/register`. To change the plan, reply with adjustments (or `/cancel`).',
  );
  return lines.join('\n');
}

export function userHasReusableAgents(userId: string): boolean {
  return listUserAgents(userId).length > 0;
}

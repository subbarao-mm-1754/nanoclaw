import type { GatewayAgentFile, GatewayWorkspace } from '../types.js';
import { listAgentFiles } from '../store/agent-files.js';

/** Stored / display default for the master agent. */
export const MASTER_ROUTING_DESCRIPTION =
  'General assistant for everyday questions, research, and drafting';

/** Laya: each choice option ≤ ~48 tokens. */
export const LAYA_OPTION_TOKEN_LIMIT = 48;
/** Laya: all options in one choice share a ~176-token budget. */
export const LAYA_OPTIONS_TOTAL_LIMIT = 176;
/** Headroom — our estimate under-counts vs Laya's tokenizer. */
export const LAYA_OPTIONS_TOTAL_TARGET = 140;

const MAX_BLURB = 120;

export function truncateRoutingBlurb(text: string, max = MAX_BLURB): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Over-estimate tokens so we stay under Laya's real tokenizer budget.
 * Biased high on purpose (HTTP 400 if we go over).
 */
export function estimateLayaTokens(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  // ~1 token per 2.5 chars + 1 per whitespace gap — intentionally high.
  return Math.max(1, Math.ceil(t.length / 2.5) + (t.match(/\s/g)?.length ?? 0));
}

/** Per-option budget given how many agents share the 176-token pool. */
export function perOptionTokenBudget(agentCount: number): number {
  const n = Math.max(2, agentCount);
  // Reserve ~1 token per short key (a0, a1, …).
  const usable = LAYA_OPTIONS_TOTAL_TARGET - n;
  return Math.max(6, Math.min(36, Math.floor(usable / n)));
}

/** Truncate text until estimated tokens ≤ maxTokens. */
export function clampToLayaTokens(text: string, maxTokens: number): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (estimateLayaTokens(t) <= maxTokens) return t;
  while (t.length > 4 && estimateLayaTokens(t) > maxTokens) {
    t = t.slice(0, Math.max(4, t.length - 6)).trimEnd();
  }
  if (estimateLayaTokens(t) > maxTokens) {
    t = t.slice(0, Math.max(4, maxTokens * 2)).trimEnd();
  }
  return t.endsWith('…') ? t : `${t}…`;
}

/**
 * Build a Laya criteria value for one agent.
 * `maxTokens` should come from perOptionTokenBudget(agentCount).
 */
export function formatLayaOptionCriteria(
  agent: GatewayWorkspace,
  isCurrent: boolean,
  maxTokens: number = perOptionTokenBudget(2),
): string {
  const rawName = agent.name.replace(/\s+/g, ' ').trim() || 'Agent';
  const name = clampToLayaTokens(rawName, Math.min(10, Math.max(4, Math.floor(maxTokens / 3))));
  const specialty = resolveRoutingDescription(agent)
    .replace(new RegExp(`^${escapeRegExp(agent.name)}\\s*[—:-]\\s*`, 'i'), '')
    .replace(new RegExp(`^${escapeRegExp(rawName)}\\s*[—:-]\\s*`, 'i'), '')
    .trim();
  const mark = isCurrent ? '*' : '';
  const base = specialty
    ? `${name}${mark}: ${specialty}`
    : `${name}${mark}`;
  return clampToLayaTokens(base, maxTokens);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a short Laya criteria string from stored description or agent files. */
export function resolveRoutingDescription(
  agent: GatewayWorkspace,
  files?: GatewayAgentFile[],
): string {
  if (agent.routing_description?.trim()) {
    return truncateRoutingBlurb(agent.routing_description);
  }
  if (agent.is_master) {
    return truncateRoutingBlurb(`${agent.name} — ${MASTER_ROUTING_DESCRIPTION}`);
  }

  const agentFiles = files ?? listAgentFiles(agent.workspace_id);
  const local = agentFiles.find(
    (f) => f.path === 'CLAUDE.local.md' || f.path.endsWith('/CLAUDE.local.md'),
  );
  if (local?.content) {
    for (const line of local.content.split('\n')) {
      const cleaned = line.trim().replace(/^#+\s*/, '');
      if (!cleaned || cleaned.length < 12) continue;
      if (/^you are\b/i.test(cleaned)) continue;
      return truncateRoutingBlurb(`${agent.name} — ${cleaned}`);
    }
  }

  const kind = agent.agent_kind === 'orchestrator' ? 'orchestrator' : 'specialist agent';
  return truncateRoutingBlurb(`${agent.name} — ${kind}`);
}

/** Prefer an explicit short specialty; else derive from files / title. */
export function buildRoutingDescription(input: {
  name: string;
  is_master?: boolean;
  explicit?: string | null;
  files?: GatewayAgentFile[];
  titleHint?: string | null;
}): string {
  if (input.is_master) {
    return truncateRoutingBlurb(`${input.name} — ${MASTER_ROUTING_DESCRIPTION}`);
  }
  if (input.explicit?.trim()) {
    return truncateRoutingBlurb(input.explicit);
  }
  if (input.titleHint?.trim() && input.titleHint.trim().length > 8) {
    return truncateRoutingBlurb(`${input.name} — ${input.titleHint.trim()}`);
  }
  return resolveRoutingDescription(
    {
      workspace_id: '',
      agent_group_id: '',
      name: input.name,
      is_default: false,
      is_master: false,
      owner_user_id: null,
      folder: null,
      cli_scope: 'group',
      container_config: null,
      worker_content_hash: null,
      agent_kind: 'agent',
      routing_description: null,
      created_at: '',
      updated_at: '',
    },
    input.files,
  );
}

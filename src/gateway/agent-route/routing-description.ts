import {
  DECISION_OPTION_TOKEN_LIMIT,
  DECISION_OPTIONS_TOTAL_LIMIT,
  DECISION_ROUTING_BLURB_CHARS,
} from '../../config.js';
import type { GatewayAgentFile, GatewayWorkspace } from '../types.js';
import { listAgentFiles } from '../store/agent-files.js';

/** Stored / display default for the master agent. */
export const MASTER_ROUTING_DESCRIPTION =
  'General assistant for everyday questions, research, and drafting';

/**
 * Headroom under the shared cap — our estimate under-counts vs the real tokenizer.
 * Aim for ~85% of the configured limit.
 */
export function decisionOptionsTotalTarget(): number {
  return Math.max(
    32,
    Math.floor(DECISION_OPTIONS_TOTAL_LIMIT * 0.85),
  );
}

export function truncateRoutingBlurb(
  text: string,
  max = DECISION_ROUTING_BLURB_CHARS,
): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Over-estimate tokens so we stay under the decision model's real tokenizer budget.
 * Biased high on purpose (HTTP 400 if we go over on tight models).
 */
export function estimateDecisionTokens(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  // ~1 token per 2.5 chars + 1 per whitespace gap — intentionally high.
  return Math.max(1, Math.ceil(t.length / 2.5) + (t.match(/\s/g)?.length ?? 0));
}

/** Per-option budget given how many agents share the options pool. */
export function perOptionTokenBudget(agentCount: number): number {
  const n = Math.max(2, agentCount);
  // Reserve ~1 token per short key (a0, a1, …).
  const usable = decisionOptionsTotalTarget() - n;
  const per = Math.floor(usable / n);
  return Math.max(6, Math.min(DECISION_OPTION_TOKEN_LIMIT, per));
}

/** Truncate text until estimated tokens ≤ maxTokens. */
export function clampToDecisionTokens(text: string, maxTokens: number): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (estimateDecisionTokens(t) <= maxTokens) return t;
  while (t.length > 4 && estimateDecisionTokens(t) > maxTokens) {
    t = t.slice(0, Math.max(4, t.length - 6)).trimEnd();
  }
  if (estimateDecisionTokens(t) > maxTokens) {
    t = t.slice(0, Math.max(4, maxTokens * 2)).trimEnd();
  }
  return t.endsWith('…') ? t : `${t}…`;
}

/**
 * Build a decision-model criteria value for one agent.
 * `maxTokens` should come from perOptionTokenBudget(agentCount).
 */
export function formatOptionCriteria(
  agent: GatewayWorkspace,
  isCurrent: boolean,
  maxTokens: number = perOptionTokenBudget(2),
): string {
  const rawName = agent.name.replace(/\s+/g, ' ').trim() || 'Agent';
  const nameBudget = Math.min(
    Math.max(8, Math.floor(maxTokens / 4)),
    Math.floor(maxTokens / 2),
  );
  const name = clampToDecisionTokens(rawName, nameBudget);
  const specialty = resolveRoutingDescription(agent)
    .replace(new RegExp(`^${escapeRegExp(agent.name)}\\s*[—:-]\\s*`, 'i'), '')
    .replace(new RegExp(`^${escapeRegExp(rawName)}\\s*[—:-]\\s*`, 'i'), '')
    .trim();
  const mark = isCurrent ? '*' : '';
  const base = specialty
    ? `${name}${mark}: ${specialty}`
    : `${name}${mark}`;
  return clampToDecisionTokens(base, maxTokens);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize a CLAUDE.local.md line for routing specialty extraction. */
function normalizeMdLine(line: string): string {
  return line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulSpecialtyLine(cleaned: string, agentName: string): boolean {
  if (!cleaned || cleaned.length < 24) return false;
  const lower = cleaned.toLowerCase();
  const name = agentName.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name) return true;
  // Skip H1/title lines that are just the agent name (common CLAUDE.local.md pattern).
  if (lower === name) return false;
  if (/^(your role|core rules|overview|instructions|capabilities|tools)\b/i.test(cleaned)) {
    return false;
  }
  return true;
}

/**
 * Pull short capability labels from "## Your role" / similar sections
 * (e.g. "**Clients / contacts** — …" → "Clients / contacts").
 */
function extractCapabilityLabels(content: string, max = 6): string[] {
  const labels: string[] = [];
  let inSection = false;
  for (const raw of content.split('\n')) {
    const heading = raw.trim().match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      inSection = /^(your role|capabilities|what you (do|handle)|responsibilities)\b/i.test(
        heading[1]!.trim(),
      );
      continue;
    }
    if (!inSection) continue;
    const bold = raw.trim().match(/^[-*•]\s+\*\*([^*]+)\*\*/);
    const plain = raw.trim().match(/^[-*•]\s+([^—:\n]{3,40})\s*[—:-]/);
    const label = (bold?.[1] ?? plain?.[1])?.replace(/\s+/g, ' ').trim();
    if (!label || label.length < 3) continue;
    if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) continue;
    labels.push(label);
    if (labels.length >= max) break;
  }
  return labels;
}

function capabilityLabelCovered(baseLower: string, label: string): boolean {
  // "Clients / contacts" needs both parts present — don't drop it just because "clients" exists.
  const parts = label
    .toLowerCase()
    .split(/[/&,]| and /)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  if (parts.length === 0) return baseLower.includes(label.toLowerCase());
  return parts.every((p) => baseLower.includes(p));
}

function withCapabilityLabels(base: string, content: string): string {
  const labels = extractCapabilityLabels(content);
  if (labels.length === 0) return base;
  const lower = base.toLowerCase();
  const missing = labels.filter((l) => !capabilityLabelCovered(lower, l));
  if (missing.length === 0) return base;
  return `${base} Topics: ${missing.join('; ')}.`;
}

/** Build a routing criteria string from stored description or agent files. */
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
    const lines = local.content.split('\n').map(normalizeMdLine);
    let specialty: string | null = null;
    // Prefer the role line ("You are …") — it usually states specialty clearly.
    for (const cleaned of lines) {
      if (!isUsefulSpecialtyLine(cleaned, agent.name)) continue;
      if (/^you are\b/i.test(cleaned)) {
        specialty = cleaned;
        break;
      }
    }
    if (!specialty) {
      for (const cleaned of lines) {
        if (!isUsefulSpecialtyLine(cleaned, agent.name)) continue;
        if (/^you are\b/i.test(cleaned)) continue;
        specialty = cleaned;
        break;
      }
    }
    if (specialty) {
      return truncateRoutingBlurb(
        withCapabilityLabels(`${agent.name} — ${specialty}`, local.content),
      );
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

import type { GatewayAgentFile, ParsedBuildResult, ParsedBuildStatus } from '../types.js';

const FENCE_RE = /```nanoclaw-build\s*([\s\S]*?)```/i;

function asStatus(value: unknown): ParsedBuildStatus | null {
  if (value === 'needs_input' || value === 'progress' || value === 'completed' || value === 'failed') {
    return value;
  }
  return null;
}

function parseFiles(raw: unknown): GatewayAgentFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: GatewayAgentFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.path !== 'string' || typeof obj.content !== 'string') continue;
    const path = obj.path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!path || path.includes('..')) continue;
    files.push({ path, content: obj.content });
  }
  return files.length > 0 ? files : undefined;
}

/** Extract the last nanoclaw-build fence from builder outbound text. */
export function parseBuildResultFromText(text: string): ParsedBuildResult | null {
  const matches = [...text.matchAll(new RegExp(FENCE_RE, 'gi'))];
  const last = matches[matches.length - 1];
  if (!last?.[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const status = asStatus(obj.status);
  if (!status) return null;

  return {
    status,
    agent_name: typeof obj.agent_name === 'string' ? obj.agent_name : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
    files: parseFiles(obj.files),
  };
}

export function parseBuildResultFromOutbound(
  outbound: Array<{ content?: Record<string, unknown> }>,
): ParsedBuildResult | null {
  let last: ParsedBuildResult | null = null;
  for (const msg of outbound) {
    const text =
      typeof msg.content?.text === 'string'
        ? msg.content.text
        : typeof msg.content === 'object' && msg.content
          ? JSON.stringify(msg.content)
          : '';
    const parsed = parseBuildResultFromText(text);
    if (parsed) last = parsed;
  }
  return last;
}

/** Strip the machine fence so users see the human-readable part. */
export function stripBuildFence(text: string): string {
  return text.replace(FENCE_RE, '').trim();
}

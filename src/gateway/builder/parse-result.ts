import type { GatewayAgentFile, ParsedBuildResult, ParsedBuildStatus } from '../types.js';

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

function parseSpecialists(raw: unknown): ParsedBuildResult['specialists'] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<ParsedBuildResult['specialists']> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    const action = obj.action === 'reuse' ? 'reuse' : 'create';
    out.push({
      name,
      action,
      agent_name: typeof obj.agent_name === 'string' ? obj.agent_name : undefined,
      role: typeof obj.role === 'string' ? obj.role : undefined,
      workspace_id: typeof obj.workspace_id === 'string' ? obj.workspace_id : undefined,
      reuse_name: typeof obj.reuse_name === 'string' ? obj.reuse_name : undefined,
      files: parseFiles(obj.files),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseGraph(raw: unknown): ParsedBuildResult['graph'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) return undefined;
  const nodes: NonNullable<ParsedBuildResult['graph']>['nodes'] = [];
  for (const n of obj.nodes) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id.trim()) continue;
    nodes.push({
      id: node.id.trim(),
      agent: typeof node.agent === 'string' ? node.agent : undefined,
      type:
        node.type === 'task' || node.type === 'decision' || node.type === 'join'
          ? node.type
          : undefined,
      description: typeof node.description === 'string' ? node.description : undefined,
    });
  }
  if (nodes.length === 0) return undefined;

  const edges: NonNullable<ParsedBuildResult['graph']>['edges'] = [];
  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const edge = e as Record<string, unknown>;
      if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
      edges.push({
        from: edge.from,
        to: edge.to,
        when: typeof edge.when === 'string' ? edge.when : undefined,
      });
    }
  }

  const loops: NonNullable<ParsedBuildResult['graph']>['loops'] = [];
  if (Array.isArray(obj.loops)) {
    for (const l of obj.loops) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) continue;
      const loop = l as Record<string, unknown>;
      if (typeof loop.from !== 'string' || typeof loop.to !== 'string') continue;
      const max =
        typeof loop.max_iterations === 'number' && loop.max_iterations > 0
          ? Math.floor(loop.max_iterations)
          : 2;
      loops.push({
        from: loop.from,
        to: loop.to,
        max_iterations: max,
        when: typeof loop.when === 'string' ? loop.when : undefined,
      });
    }
  }

  return {
    entry: typeof obj.entry === 'string' ? obj.entry : nodes[0]?.id,
    nodes,
    edges: edges.length ? edges : undefined,
    loops: loops.length ? loops : undefined,
  };
}

function parseBuildObject(raw: string): ParsedBuildResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const status = asStatus(obj.status);
  if (!status) return null;

  const agentKind =
    obj.agent_kind === 'orchestrator'
      ? 'orchestrator'
      : obj.agent_kind === 'agent'
        ? 'agent'
        : undefined;

  return {
    status,
    agent_name: typeof obj.agent_name === 'string' ? obj.agent_name : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
    files: parseFiles(obj.files),
    agent_kind: agentKind,
    confirmation_required:
      obj.confirmation_required === true
        ? true
        : obj.confirmation_required === false
          ? false
          : undefined,
    specialists: parseSpecialists(obj.specialists),
    graph: parseGraph(obj.graph),
  };
}

/**
 * Extract a JSON object starting at `start`, respecting strings so nested
 * ``` inside file contents cannot truncate the payload.
 */
export function extractJsonObjectAt(text: string, start: number): string | null {
  const i0 = text.indexOf('{', start);
  if (i0 < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = i0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(i0, i + 1);
    }
  }
  return null;
}

/**
 * Find every ```nanoclaw-build … payload (brace-scanned JSON), last wins.
 * Nested triple-backticks inside file content must not truncate the match.
 */
function extractNanoclawBuildPayloads(text: string): string[] {
  const payloads: string[] = [];
  const markerRe = /```nanoclaw-build\b/gi;
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(text)) !== null) {
    const json = extractJsonObjectAt(text, match.index + match[0].length);
    if (json) payloads.push(json);
  }
  return payloads;
}

/** Fallback: plain ```json fence whose body has our status field — brace-scanned. */
function extractJsonStatusPayloads(text: string): string[] {
  const payloads: string[] = [];
  const markerRe = /```(?:json)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(text)) !== null) {
    // Skip nanoclaw-build markers (handled above).
    const after = text.slice(match.index, match.index + 20).toLowerCase();
    if (after.includes('nanoclaw-build')) continue;
    const json = extractJsonObjectAt(text, match.index + match[0].length);
    if (!json) continue;
    if (!/"status"\s*:/.test(json)) continue;
    payloads.push(json);
  }
  return payloads;
}

/** Extract the last nanoclaw-build (or compatible JSON) result from builder text. */
export function parseBuildResultFromText(text: string): ParsedBuildResult | null {
  const tagged = extractNanoclawBuildPayloads(text);
  for (let i = tagged.length - 1; i >= 0; i--) {
    const parsed = parseBuildObject(tagged[i]!);
    if (parsed) return parsed;
  }

  const jsonFences = extractJsonStatusPayloads(text);
  for (let i = jsonFences.length - 1; i >= 0; i--) {
    const parsed = parseBuildObject(jsonFences[i]!);
    if (parsed) return parsed;
  }

  return null;
}

export function parseBuildResultFromOutbound(
  outbound: Array<{ content?: Record<string, unknown> }>,
): ParsedBuildResult | null {
  let last: ParsedBuildResult | null = null;
  for (const msg of outbound) {
    const candidates = [
      typeof msg.content?.raw_text === 'string' ? msg.content.raw_text : '',
      typeof msg.content?.text === 'string' ? msg.content.text : '',
      typeof msg.content === 'object' && msg.content ? JSON.stringify(msg.content) : '',
    ];
    for (const text of candidates) {
      if (!text) continue;
      const parsed = parseBuildResultFromText(text);
      if (parsed) last = parsed;
    }
  }
  return last;
}

/**
 * Remove nanoclaw-build / status JSON fences for human display.
 * Uses brace-aware extraction so nested ``` in file bodies are not treated as fence ends.
 */
export function stripBuildFence(text: string): string {
  let out = text;
  const markerRe = /```nanoclaw-build\b/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(text)) !== null) {
    const json = extractJsonObjectAt(text, match.index + match[0].length);
    if (!json) continue;
    const jsonStart = text.indexOf(json, match.index);
    let end = jsonStart + json.length;
    const close = text.slice(end).match(/^\s*```/);
    if (close) end += close[0].length;
    ranges.push({ start: match.index, end });
  }
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out.trim();
}

/** True when the builder claimed the agent is done but forgot a parseable registration fence. */
export function looksLikeUnregisteredCompletion(text: string): boolean {
  if (parseBuildResultFromText(text)?.status === 'completed') return false;
  // Negatives: still asking / clarifying that nothing is registered yet.
  if (
    /\b(not|n't|never|nothing is|isn'?t|is not)\s+(?:yet\s+)?(?:been\s+)?(?:registered|created|built)\b/i.test(
      text,
    ) ||
    /\buntil i emit\b/i.test(text) ||
    /\bstill waiting\b/i.test(text)
  ) {
    return false;
  }
  return /\b(ready to register|submitting the registration|submitted the completed|registering\b|agent is defined|is defined and ready|build(?:ing)? (?:is )?complete(?:d)?|agent is ready|emitted the completed|emitting the completed|create(?:d)? this agent|block below[, ].{0,40}[Gg]ateway|defined below)\b/i.test(
    text,
  );
}

/** User wants Gateway to finish registration without typing `/register`. */
export function looksLikeRegisterIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\/register\b/i.test(t)) return true;
  return /^(please\s+)?(register(\s+it)?(\s+now)?|create(\s+it|\s+the\s+agent)?(\s+now)?)\.?$/i.test(
    t,
  );
}

/**
 * True when an edit turn claims the draft was updated but there is no parseable
 * files payload — `/test` would still run the original agent.
 *
 * Keep this conservative: bare words like "caption" false-positive on MoodEmoji's
 * intro ("short caption… What would you like to change?").
 */
export function looksLikeEditClaimWithoutFiles(text: string): boolean {
  const parsed = parseBuildResultFromText(text);
  if (parsed?.files && parsed.files.length > 0) return false;
  return /\b(i(?:'ve| have)\s+(?:updated|changed|edited|modified)|i\s+updated|draft\s+(?:is\s+)?(?:updated|ready)|try(?:\s+it)?\s+with\s+`?\/test|will now|now (?:reply|respond)|key changes|i made|added (?:an? )?explicit|reinforced that)\b/i.test(
    text,
  );
}

export function filesFromMemoryPatch(
  patch?: { files?: Array<{ path: string; content: string; deleted?: boolean }> },
): GatewayAgentFile[] {
  if (!patch?.files?.length) return [];
  const out: GatewayAgentFile[] = [];
  for (const file of patch.files) {
    if (file.deleted || typeof file.content !== 'string') continue;
    const path = file.path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!path || path.includes('..')) continue;
    out.push({ path, content: file.content });
  }
  return out;
}

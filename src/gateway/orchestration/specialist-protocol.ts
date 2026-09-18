/**
 * Specialist ↔ orchestrator reply protocol for LangGraph runs.
 *
 * Specialists must signal status explicitly so the Gateway does not treat
 * "On it…" acknowledgments as node completions.
 *
 * Wire formats (any one is enough):
 * 1. Outbound content field `orchestration: { status, payload?, notify_orchestrator?, summary? }`
 * 2. Fence in text:
 *    ```nanoclaw-result
 *    { "status": "completed", "payload": "..." }
 *    ```
 * 3. Legacy plain text — inferred (short ack-like → ack; otherwise completed)
 */

export const SPECIALIST_REPLY_STATUSES = [
  'ack',
  'progress',
  'completed',
  'blocked',
  'failed',
  'partial',
] as const;

export type SpecialistReplyStatus = (typeof SPECIALIST_REPLY_STATUSES)[number];

/** Statuses that finish the current await_specialist wait and advance the graph. */
export const TERMINAL_SPECIALIST_STATUSES: ReadonlySet<SpecialistReplyStatus> = new Set([
  'completed',
  'blocked',
  'failed',
  'partial',
]);

export interface SpecialistOrchestrationMeta {
  status: SpecialistReplyStatus;
  /** Final or partial deliverable (string or JSON-serializable). */
  payload?: unknown;
  /** Short note for the orchestrator (acks/progress). */
  summary?: string;
  /**
   * Soft-wake the orchestrator agent with this update (does not advance the graph).
   * Defaults: ack=false, progress=true, terminal=false (graph resume handles terminals).
   */
  notify_orchestrator?: boolean;
}

export interface ParsedSpecialistReply {
  status: SpecialistReplyStatus;
  /** Text shown / stored as SpecialistResult.text (payload preferred when present). */
  text: string;
  /** Raw payload when provided. */
  payload?: unknown;
  summary?: string;
  notify_orchestrator: boolean;
  /** True when status came from explicit protocol (not legacy inference). */
  explicit: boolean;
}

const RESULT_FENCE_RE = /```nanoclaw-result\b\s*([\s\S]*?)```/i;

function isStatus(value: unknown): value is SpecialistReplyStatus {
  return (
    typeof value === 'string' &&
    (SPECIALIST_REPLY_STATUSES as readonly string[]).includes(value.toLowerCase())
  );
}

function normalizeStatus(value: string): SpecialistReplyStatus {
  return value.toLowerCase() as SpecialistReplyStatus;
}

function defaultNotify(status: SpecialistReplyStatus): boolean {
  return status === 'progress';
}

function payloadToText(payload: unknown, fallback: string): string {
  if (payload === undefined || payload === null) return fallback;
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return fallback;
  }
}

function stripResultFence(text: string): string {
  return text.replace(RESULT_FENCE_RE, '').trim();
}

function parseMetaObject(raw: unknown): SpecialistOrchestrationMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isStatus(obj.status)) return null;
  return {
    status: normalizeStatus(obj.status),
    payload: obj.payload,
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    notify_orchestrator:
      typeof obj.notify_orchestrator === 'boolean' ? obj.notify_orchestrator : undefined,
  };
}

function parseResultFence(text: string): SpecialistOrchestrationMeta | null {
  const m = text.match(RESULT_FENCE_RE);
  if (!m?.[1]) return null;
  try {
    return parseMetaObject(JSON.parse(m[1].trim()));
  } catch {
    return null;
  }
}

/**
 * Infer status for legacy plain-text specialist replies (no protocol fields).
 * Short status-only acknowledgments → ack; everything else → completed.
 */
export function inferSpecialistReplyStatus(text: string): SpecialistReplyStatus {
  const t = text.trim();
  if (!t) return 'ack';
  if (t.length <= 400) {
    if (
      /^(on it|got it|ack(?:nowledged)?|working(?: on it)?|looking into|starting|will do|roger|ok(?:ay)?[,!. ]|sure[,!. ]|received)\b/i.test(
        t,
      )
    ) {
      return 'ack';
    }
    if (/^(update|progress|status|fyi|heads-?up)\s*[:—-]/i.test(t)) {
      return 'progress';
    }
  }
  return 'completed';
}

/**
 * Parse specialist outbound content + text into a protocol reply.
 * `content` is the WorkerCollectedOutbound.content object (or similar).
 */
export function parseSpecialistReply(
  content: Record<string, unknown> | null | undefined,
  fallbackText: string,
): ParsedSpecialistReply {
  const textFromContent =
    typeof content?.text === 'string'
      ? content.text
      : typeof content?.raw_text === 'string'
        ? content.raw_text
        : fallbackText;
  const text = textFromContent || fallbackText || '';

  const fromField = parseMetaObject(content?.orchestration);
  const fromFence = parseResultFence(text);
  const meta = fromField ?? fromFence;

  if (meta) {
    const body = stripResultFence(text);
    const resultText = payloadToText(meta.payload, meta.summary || body || text);
    const notify = meta.notify_orchestrator ?? defaultNotify(meta.status);
    return {
      status: meta.status,
      text: resultText,
      payload: meta.payload,
      summary: meta.summary,
      notify_orchestrator: notify,
      explicit: true,
    };
  }

  const status = inferSpecialistReplyStatus(text);
  return {
    status,
    text,
    notify_orchestrator: defaultNotify(status),
    explicit: false,
  };
}

export function isTerminalSpecialistStatus(status: SpecialistReplyStatus): boolean {
  return TERMINAL_SPECIALIST_STATUSES.has(status);
}

/** Human + agent instructions for the protocol (orchestrator + specialists + builder). */
export function specialistReplyProtocolDocs(): string {
  return `### Specialist reply protocol (required)

Specialists report back to the orchestrator with an explicit **status**. The Gateway
advances the graph only on terminal statuses. Acknowledgments must not complete a node.

Statuses:
- \`ack\` — received the task; still working. Does **not** advance the graph. Not shown to the user.
- \`progress\` — milestone update; still working. Does **not** advance the graph. Not shown to the user
  (orchestrator may be soft-notified when \`notify_orchestrator: true\`, default for progress).
- \`completed\` — final deliverable. Advances the graph.
- \`blocked\` / \`failed\` — cannot finish; include reason. Advances the graph (orchestrator decides).
- \`partial\` — best-effort result (e.g. after nudge). Advances the graph.

**How to send (pick one):**

1. MCP: \`send_message({ to: "orchestrator", text: "...", orchestration_status: "completed" })\`
   Optional: \`notify_orchestrator\` (bool), and put the deliverable in \`text\` (or a
   \`nanoclaw-result\` fence).
2. Message tag: \`<message to="orchestrator" status="ack">On it — researching…</message>\`
   Terminal: \`<message to="orchestrator" status="completed">…payload…</message>\`
3. Fence inside the message body:
\`\`\`
\`\`\`nanoclaw-result
{"status":"completed","payload":{...}}
\`\`\`
\`\`\`

Rules:
- Never send specialist traffic to the user channel. Reply only to \`orchestrator\` (agent).
- Do **not** claim the task is done with a bare "On it" — that is \`ack\` only.
- One terminal reply per assigned task is enough; further chatter should be \`progress\` or stay silent.`;
}

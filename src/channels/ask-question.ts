/**
 * Shared ask_question payload schema + normalization.
 *
 * Producers (host-side approvals, container-side ask_user_question MCP tool)
 * emit an `ask_question` payload. Options may be bare strings for ergonomics,
 * but are normalized here into a consistent shape before delivery, persistence,
 * and rendering.
 */

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function isAskQuestionType(content: Record<string, unknown>): boolean {
  const t = content.type ?? content.operation;
  return t === 'ask_question' || t === 'askquestion';
}

/**
 * Flatten an ask_question card to plain text for channels that cannot render
 * interactive buttons (e.g. native Zoho Cliq bot POST, Studio HTTP chat).
 */
export function formatAskQuestionAsText(content: Record<string, unknown>): string | null {
  let payload = content;
  if (!isAskQuestionType(payload) && typeof payload.text === 'string') {
    const nested = tryParseJsonObject(payload.text);
    if (nested && isAskQuestionType(nested)) payload = nested;
  }
  if (!isAskQuestionType(payload)) return null;
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const optionLines = rawOptions.map((o, i) => {
    if (typeof o === 'string') return `${i + 1}. ${o}`;
    if (o && typeof o === 'object' && 'label' in o) {
      return `${i + 1}. ${String((o as { label: unknown }).label)}`;
    }
    return `${i + 1}. ${String(o)}`;
  });
  const parts = [
    title ? `**${title}**` : '',
    question,
    optionLines.length ? '' : '',
    ...optionLines,
    optionLines.length ? '\nReply with your choice (number or text).' : '',
  ].filter((p) => p !== '');
  const text = parts.join('\n').trim();
  return text || null;
}

/** Chat-window text for any outbound content blob (plain text, markdown, or ask_question). */
export function outboundContentToDisplayText(content: unknown): string {
  if (typeof content === 'string') {
    const nested = tryParseJsonObject(content);
    if (nested) {
      const flat = formatAskQuestionAsText(nested);
      if (flat) return flat;
    }
    return content;
  }
  if (!content || typeof content !== 'object') return String(content ?? '');
  const rec = content as Record<string, unknown>;
  const flat = formatAskQuestionAsText(rec);
  if (flat) return flat;
  if (typeof rec.text === 'string') return rec.text;
  if (typeof rec.markdown === 'string') return rec.markdown;
  return JSON.stringify(rec);
}

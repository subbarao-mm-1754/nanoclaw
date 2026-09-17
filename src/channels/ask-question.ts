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

/**
 * Flatten an ask_question card to plain text for channels that cannot render
 * interactive buttons (e.g. native Zoho Cliq bot POST).
 */
export function formatAskQuestionAsText(content: Record<string, unknown>): string | null {
  if (content.type !== 'ask_question') return null;
  const title = typeof content.title === 'string' ? content.title.trim() : '';
  const question = typeof content.question === 'string' ? content.question.trim() : '';
  const rawOptions = Array.isArray(content.options) ? content.options : [];
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

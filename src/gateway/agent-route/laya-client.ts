import {
  LAYA_MODEL,
  LAYA_OLLAMA_URL,
} from '../../config.js';
import { log } from '../../log.js';

export type LayaChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type LayaSystemOneResponse = {
  model?: string;
  answers?: Record<string, LayaChoiceAnswer | { type: string; [key: string]: unknown }>;
};

export async function layaSystemOne(input: {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
}): Promise<LayaSystemOneResponse> {
  const url = `${LAYA_OLLAMA_URL}/v1/systemone`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model || LAYA_MODEL,
        state: input.state,
        questions: input.questions,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Laya HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as LayaSystemOneResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseLayaChoice(
  response: LayaSystemOneResponse,
  questionKey: string,
): LayaChoiceAnswer | null {
  const answer = response.answers?.[questionKey];
  if (!answer || answer.type !== 'choice') return null;
  const choice = typeof (answer as LayaChoiceAnswer).choice === 'string'
    ? (answer as LayaChoiceAnswer).choice
    : null;
  if (!choice) return null;
  const probabilities =
    typeof (answer as LayaChoiceAnswer).probabilities === 'object' &&
    (answer as LayaChoiceAnswer).probabilities
      ? (answer as LayaChoiceAnswer).probabilities
      : {};
  const confidence = Number((answer as LayaChoiceAnswer).confidence);
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

export async function safeLayaChoice(input: {
  state: unknown;
  questions: Record<string, unknown>;
  questionKey: string;
}): Promise<LayaChoiceAnswer | null> {
  const model = LAYA_MODEL;
  const url = `${LAYA_OLLAMA_URL}/v1/systemone`;
  log.info('Laya systemone request', {
    url,
    model,
    questionKey: input.questionKey,
    state: input.state,
    optionKeys: Object.keys(
      ((input.questions[input.questionKey] as { criteria?: Record<string, string> } | undefined)
        ?.criteria ?? {}) as Record<string, string>,
    ),
  });
  try {
    const started = Date.now();
    const response = await layaSystemOne({
      state: input.state,
      questions: input.questions,
      model,
    });
    const answer = parseLayaChoice(response, input.questionKey);
    log.info('Laya systemone response', {
      url,
      model,
      ms: Date.now() - started,
      choice: answer?.choice ?? null,
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? null,
    });
    return answer;
  } catch (err) {
    log.warn('Laya systemone call failed; keeping current agent', { url, model, err });
    return null;
  }
}

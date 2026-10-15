import {
  DECISION_MODEL,
  DECISION_MODEL_URL,
} from '../../config.js';
import { log } from '../../log.js';

export type DecisionChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type DecisionSystemOneResponse = {
  model?: string;
  answers?: Record<string, DecisionChoiceAnswer | { type: string; [key: string]: unknown }>;
};

export async function decisionSystemOne(input: {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
}): Promise<DecisionSystemOneResponse> {
  const url = `${DECISION_MODEL_URL}/v1/systemone`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model || DECISION_MODEL,
        state: input.state,
        questions: input.questions,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Decision model HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as DecisionSystemOneResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDecisionChoice(
  response: DecisionSystemOneResponse,
  questionKey: string,
): DecisionChoiceAnswer | null {
  const answer = response.answers?.[questionKey];
  if (!answer || answer.type !== 'choice') return null;
  const choice = typeof (answer as DecisionChoiceAnswer).choice === 'string'
    ? (answer as DecisionChoiceAnswer).choice
    : null;
  if (!choice) return null;
  const probabilities =
    typeof (answer as DecisionChoiceAnswer).probabilities === 'object' &&
    (answer as DecisionChoiceAnswer).probabilities
      ? (answer as DecisionChoiceAnswer).probabilities
      : {};
  const confidence = Number((answer as DecisionChoiceAnswer).confidence);
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

export async function safeDecisionChoice(input: {
  state: unknown;
  questions: Record<string, unknown>;
  questionKey: string;
}): Promise<DecisionChoiceAnswer | null> {
  const model = DECISION_MODEL;
  const criteria = (
    (input.questions[input.questionKey] as { criteria?: Record<string, string> } | undefined)
      ?.criteria ?? {}
  ) as Record<string, string>;
  const state = input.state as Record<string, unknown> | null;
  log.info('Decision systemone request', {
    model,
    questionKey: input.questionKey,
    optionCount: Object.keys(criteria).length,
    messageChars:
      typeof state?.message === 'string' ? state.message.length : 0,
    recentChars: typeof state?.recent === 'string' ? state.recent.length : 0,
  });
  try {
    const started = Date.now();
    const response = await decisionSystemOne({
      state: input.state,
      questions: input.questions,
      model,
    });
    const answer = parseDecisionChoice(response, input.questionKey);
    const chosenProb = answer
      ? (answer.probabilities[answer.choice] ?? null)
      : null;
    log.info('Decision systemone response', {
      model,
      ms: Date.now() - started,
      choice: answer?.choice ?? null,
      confidence: answer?.confidence ?? null,
      probability: chosenProb,
    });
    return answer;
  } catch (err) {
    log.warn('Decision systemone call failed; keeping current agent', {
      model,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

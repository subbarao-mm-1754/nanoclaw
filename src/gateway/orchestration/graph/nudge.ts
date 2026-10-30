/**
 * Timeout / nudge loop for specialist waits.
 */
import { log } from '../../../log.js';
import { getGatewayDb } from '../../db/connection.js';
import { parseRunState, type OrchestrationEvent } from '../store.js';
import type { OrchestrationRun } from '../types.js';
import { listWaitingGraphRuns, resumeTimeout, type GraphRunMeta } from './runner.js';

/** Default: nudge after 20m, fail/partial after 30m post-nudge (50m total). */
export const GRAPH_NUDGE_AFTER_MS = parseInt(
  process.env.GRAPH_NUDGE_AFTER_MS || String(20 * 60 * 1000),
  10,
);
export const GRAPH_FAIL_AFTER_MS = parseInt(
  process.env.GRAPH_FAIL_AFTER_MS || String(50 * 60 * 1000),
  10,
);
export const GRAPH_NUDGE_INTERVAL_MS = parseInt(
  process.env.GRAPH_NUDGE_INTERVAL_MS || String(60 * 1000),
  10,
);

let timer: ReturnType<typeof setInterval> | null = null;

function metaOf(run: OrchestrationRun): GraphRunMeta | null {
  const state = parseRunState(run);
  const lg = state.graph;
  if (!lg || typeof lg !== 'object') return null;
  return lg as GraphRunMeta;
}

export async function tickGraphNudges(): Promise<number> {
  const waiting = listWaitingGraphRuns(100);
  let acted = 0;
  const now = Date.now();

  for (const run of waiting) {
    const meta = metaOf(run);
    if (!meta?.interrupt || meta.interrupt.kind !== 'await_specialist') continue;
    const since = meta.waiting_since ? Date.parse(meta.waiting_since) : Date.parse(run.updated_at);
    if (!Number.isFinite(since)) continue;
    const elapsed = now - since;
    const nudges = meta.nudge_count ?? 0;

    try {
      if (elapsed >= GRAPH_FAIL_AFTER_MS) {
        await resumeTimeout(run, 'partial', {
          partialText: '(partial — specialist wait exceeded time limit)',
        });
        acted++;
      } else if (elapsed >= GRAPH_NUDGE_AFTER_MS && nudges < 1) {
        await resumeTimeout(run, 'nudge');
        acted++;
      }
    } catch (err) {
      log.warn('Graph nudge tick failed', { runId: run.id, err });
    }
  }
  return acted;
}

export function startGraphNudgeLoop(intervalMs = GRAPH_NUDGE_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickGraphNudges();
  }, intervalMs);
  // Unref so tests / short CLI don't hang (Node only).
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  log.info('Graph nudge loop started', { intervalMs });
}

export function stopGraphNudgeLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Exported for tests — avoid unused import lint on getGatewayDb in runner. */
export function countWaitingRuns(): number {
  const row = getGatewayDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM gateway_orchestration_runs WHERE status = 'waiting'`,
    )
    .get() as { c: number };
  return row?.c ?? 0;
}

export type { OrchestrationEvent };

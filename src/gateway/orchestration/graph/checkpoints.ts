/**
 * Graph checkpoints in gateway.db, keyed by orchestration run id, so a waiting
 * run resumes at the same node after a gateway restart.
 */
import { getGatewayDb } from '../../db/connection.js';
import type { Checkpoint, Checkpointer } from './engine.js';

export const orchestrationCheckpointer: Checkpointer = {
  get(threadId: string): Checkpoint | null {
    const row = getGatewayDb()
      .prepare(
        `SELECT values_json, next_node, interrupt_json
         FROM gateway_orchestration_checkpoints WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { values_json: string; next_node: string | null; interrupt_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      values: JSON.parse(row.values_json) as unknown,
      next: row.next_node,
      interrupt: row.interrupt_json ? (JSON.parse(row.interrupt_json) as Checkpoint['interrupt']) : null,
    };
  },

  put(threadId: string, checkpoint: Checkpoint): void {
    // Skipped when the run row is gone (e.g. its orchestrator was deleted mid-invoke).
    getGatewayDb()
      .prepare(
        `INSERT INTO gateway_orchestration_checkpoints (thread_id, values_json, next_node, interrupt_json, updated_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM gateway_orchestration_runs WHERE id = ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           values_json = excluded.values_json,
           next_node = excluded.next_node,
           interrupt_json = excluded.interrupt_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        JSON.stringify(checkpoint.values),
        checkpoint.next,
        checkpoint.interrupt ? JSON.stringify(checkpoint.interrupt) : null,
        new Date().toISOString(),
        threadId,
      );
  },
};

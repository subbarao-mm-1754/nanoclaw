import { getGatewayDb } from '../db/connection.js';
import { getOrCreateConversation } from '../store/conversations.js';
import { getWorkspace } from '../store/workspaces.js';
import type { GatewaySchedule, GatewayScheduleRun, GatewayScheduleRunStatus } from '../types.js';
import { nextCronOccurrence, validateCron } from './cron.js';

function now(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rowToSchedule(row: Record<string, unknown>): GatewaySchedule {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    conversation_id: row.conversation_id as string,
    prompt: row.prompt as string,
    cron_expression: row.cron_expression as string,
    timezone: row.timezone as string,
    channel_type: row.channel_type as string,
    platform_id: row.platform_id as string,
    thread_id: (row.thread_id as string | null) ?? null,
    enabled: Boolean(row.enabled),
    next_run_at: row.next_run_at as string,
    active_run_id: (row.active_run_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToRun(row: Record<string, unknown>): GatewayScheduleRun {
  return {
    id: row.id as string,
    schedule_id: row.schedule_id as string,
    inbound_message_id: row.inbound_message_id as string,
    scheduled_for: row.scheduled_for as string,
    status: row.status as GatewayScheduleRunStatus,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface CreateGatewayScheduleInput {
  id?: string;
  workspace_id: string;
  prompt: string;
  cron_expression: string;
  timezone: string;
  delivery: {
    channel_type: string;
    platform_id: string;
    thread_id?: string | null;
  };
}

/**
 * Create a gateway-owned schedule. Its synthetic conversation provides an
 * isolated agent session; output routing remains the requested delivery target.
 */
export function createGatewaySchedule(input: CreateGatewayScheduleInput): GatewaySchedule {
  if (!input.prompt.trim()) throw new Error('Schedule prompt cannot be empty');
  if (!input.delivery.channel_type || !input.delivery.platform_id) {
    throw new Error('Schedule delivery channel_type and platform_id are required');
  }
  validateCron(input.cron_expression, input.timezone);
  const workspace = getWorkspace(input.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${input.workspace_id}`);

  const id = input.id ?? newId('schedule');
  const conversation = getOrCreateConversation({
    channel_type: 'schedule',
    platform_id: id,
    thread_id: null,
    display_name: `Schedule ${id}`,
    workspace_id: workspace.workspace_id,
  });
  const ts = now();
  const nextRunAt = nextCronOccurrence(input.cron_expression, input.timezone, new Date(ts)).toISOString();

  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_schedules (
         id, workspace_id, conversation_id, prompt, cron_expression, timezone,
         channel_type, platform_id, thread_id, next_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspace.workspace_id,
      conversation.id,
      input.prompt.trim(),
      input.cron_expression.trim(),
      input.timezone,
      input.delivery.channel_type,
      input.delivery.platform_id,
      input.delivery.thread_id ?? null,
      nextRunAt,
      ts,
      ts,
    );
  return getGatewaySchedule(id)!;
}

export function getGatewaySchedule(id: string): GatewaySchedule | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_schedules WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSchedule(row) : null;
}

export function listGatewaySchedules(workspaceId?: string): GatewaySchedule[] {
  const db = getGatewayDb();
  const rows = workspaceId
    ? db.prepare('SELECT * FROM gateway_schedules WHERE workspace_id = ? ORDER BY next_run_at').all(workspaceId)
    : db.prepare('SELECT * FROM gateway_schedules ORDER BY next_run_at').all();
  return (rows as Record<string, unknown>[]).map(rowToSchedule);
}

export function setGatewayScheduleEnabled(id: string, enabled: boolean): boolean {
  const result = getGatewayDb()
    .prepare('UPDATE gateway_schedules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, now(), id);
  return result.changes > 0;
}

export function updateGatewaySchedule(
  id: string,
  patch: { prompt?: string; cron_expression?: string; timezone?: string },
): GatewaySchedule | null {
  const current = getGatewaySchedule(id);
  if (!current) return null;
  const prompt = patch.prompt?.trim() ?? current.prompt;
  const cronExpression = patch.cron_expression?.trim() ?? current.cron_expression;
  const timezone = patch.timezone?.trim() ?? current.timezone;
  if (!prompt) throw new Error('Schedule prompt cannot be empty');
  validateCron(cronExpression, timezone);
  const scheduleChanged = cronExpression !== current.cron_expression || timezone !== current.timezone;
  const nextRunAt = scheduleChanged
    ? nextCronOccurrence(cronExpression, timezone, new Date()).toISOString()
    : current.next_run_at;
  getGatewayDb()
    .prepare(
      `UPDATE gateway_schedules
          SET prompt = ?, cron_expression = ?, timezone = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(prompt, cronExpression, timezone, nextRunAt, now(), id);
  return getGatewaySchedule(id);
}

export function deleteGatewaySchedule(id: string): boolean {
  const result = getGatewayDb().prepare('DELETE FROM gateway_schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Clear terminal runs so their schedules may fire again. */
export function reconcileGatewayScheduleRuns(): void {
  const db = getGatewayDb();
  const ts = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE gateway_schedule_runs
          SET status = 'failed', error = COALESCE(error, 'Gateway message processing failed'), updated_at = ?
        WHERE status = 'enqueued'
          AND EXISTS (
            SELECT 1 FROM customer_messages m
             WHERE m.id = gateway_schedule_runs.inbound_message_id AND m.status = 'failed'
          )`,
    ).run(ts);
    db.prepare(
      `UPDATE gateway_schedule_runs
          SET status = 'completed', updated_at = ?
        WHERE status = 'enqueued'
          AND NOT EXISTS (
            SELECT 1 FROM customer_messages m
             WHERE m.id = gateway_schedule_runs.inbound_message_id
          )`,
    ).run(ts);
    db.prepare(
      `UPDATE gateway_schedules
          SET active_run_id = NULL, updated_at = ?
        WHERE active_run_id IN (
          SELECT id FROM gateway_schedule_runs WHERE status IN ('completed', 'failed')
        )`,
    ).run(ts);
  })();
}

export interface ClaimedGatewaySchedule {
  schedule: GatewaySchedule;
  run: GatewayScheduleRun;
}

/**
 * Reserve one due schedule and advance its next slot before the worker runs.
 * An active run remains reserved until normal gateway message lifecycle marks it terminal.
 */
export function claimDueGatewaySchedule(at: Date = new Date()): ClaimedGatewaySchedule | null {
  const db = getGatewayDb();
  const ts = at.toISOString();
  const candidate = db
    .prepare(
      `SELECT * FROM gateway_schedules
        WHERE enabled = 1 AND active_run_id IS NULL AND datetime(next_run_at) <= datetime(?)
        ORDER BY next_run_at
        LIMIT 1`,
    )
    .get(ts) as Record<string, unknown> | undefined;
  if (!candidate) return null;

  const schedule = rowToSchedule(candidate);
  const runId = newId('schedule-run');
  const inboundMessageId = `schedule-message-${runId}`;
  const nextRunAt = nextCronOccurrence(schedule.cron_expression, schedule.timezone, at).toISOString();
  const claimed = db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE gateway_schedules
            SET active_run_id = ?, next_run_at = ?, updated_at = ?
          WHERE id = ? AND enabled = 1 AND active_run_id IS NULL AND datetime(next_run_at) <= datetime(?)`,
      )
      .run(runId, nextRunAt, ts, schedule.id, ts);
    if (updated.changes === 0) return false;
    db.prepare(
      `INSERT INTO gateway_schedule_runs (
         id, schedule_id, inbound_message_id, scheduled_for, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
    ).run(runId, schedule.id, inboundMessageId, schedule.next_run_at, ts, ts);
    return true;
  })();
  if (!claimed) return null;

  const run = {
    id: runId,
    schedule_id: schedule.id,
    inbound_message_id: inboundMessageId,
    scheduled_for: schedule.next_run_at,
    status: 'claimed' as const,
    error: null,
    created_at: ts,
    updated_at: ts,
  };
  return { schedule: { ...schedule, active_run_id: runId, next_run_at: nextRunAt, updated_at: ts }, run };
}

export function markGatewayScheduleRunEnqueued(runId: string): void {
  getGatewayDb()
    .prepare(`UPDATE gateway_schedule_runs SET status = 'enqueued', updated_at = ? WHERE id = ?`)
    .run(now(), runId);
}

export function failGatewayScheduleRun(runId: string, error: string): void {
  const db = getGatewayDb();
  const ts = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE gateway_schedule_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    ).run(error, ts, runId);
    db.prepare(`UPDATE gateway_schedules SET active_run_id = NULL, updated_at = ? WHERE active_run_id = ?`).run(
      ts,
      runId,
    );
  })();
}

export function listGatewayScheduleRuns(scheduleId: string): GatewayScheduleRun[] {
  return (
    getGatewayDb()
      .prepare('SELECT * FROM gateway_schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC')
      .all(scheduleId) as Record<string, unknown>[]
  ).map(rowToRun);
}

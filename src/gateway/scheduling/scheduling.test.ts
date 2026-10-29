import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeGatewayDb, getGatewayDb, initGatewayTestDb } from '../db/connection.js';
import { getMessage } from '../store/messages.js';
import { registerWorkspace } from '../store/workspaces.js';
import { nextCronOccurrence } from './cron.js';
import { createGatewayScheduleExecutor } from './executor.js';
import {
  createGatewaySchedule,
  finishGatewayScheduleRun,
  getGatewaySchedule,
  listGatewayScheduleRuns,
} from './store.js';
import { applyScheduleAction } from './actions.js';

const tickAt = new Date('2026-10-27T09:15:30.000Z');

beforeEach(() => {
  initGatewayTestDb();
  registerWorkspace({
    workspace_id: 'ws-schedule',
    agent_group_id: 'ag-schedule',
    name: 'Scheduled Agent',
    is_default: true,
  });
});

afterEach(() => {
  closeGatewayDb();
});

describe('gateway scheduling', () => {
  it('finds cron occurrences in the requested timezone', () => {
    const next = nextCronOccurrence('0 9 * * 1-5', 'Asia/Kolkata', new Date('2026-10-26T03:29:00Z'));
    expect(next.toISOString()).toBe('2026-10-26T03:30:00.000Z');
  });

  it('enqueues a due schedule as an isolated task message', async () => {
    const schedule = createGatewaySchedule({
      id: 'schedule-daily-summary',
      workspace_id: 'ws-schedule',
      prompt: 'Produce the daily summary.',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      delivery: { channel_type: 'zoho-cliq', platform_id: 'chat-1' },
    });
    getGatewayDb()
      .prepare('UPDATE gateway_schedules SET next_run_at = ? WHERE id = ?')
      .run('2026-10-27T09:15:00.000Z', schedule.id);

    const executor = createGatewayScheduleExecutor({ intervalMs: 60_000, now: () => tickAt });
    expect(await executor.tick()).toBe(1);

    const runs = listGatewayScheduleRuns(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('enqueued');
    const inbound = getMessage(runs[0]!.inbound_message_id);
    expect(inbound?.kind).toBe('task');
    expect(inbound?.conversation_id).toBe(schedule.conversation_id);
    expect(JSON.parse(inbound!.content_json)).toMatchObject({
      prompt: 'Produce the daily summary.',
      scheduleId: schedule.id,
      runId: runs[0]!.id,
    });
    expect(getGatewaySchedule(schedule.id)?.next_run_at).toBe('2026-10-28T09:00:00.000Z');
  });

  it('does not enqueue an overlapping scheduled run', async () => {
    const schedule = createGatewaySchedule({
      id: 'schedule-no-overlap',
      workspace_id: 'ws-schedule',
      prompt: 'Do the scheduled work.',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      delivery: { channel_type: 'zoho-cliq', platform_id: 'chat-1' },
    });
    getGatewayDb()
      .prepare('UPDATE gateway_schedules SET next_run_at = ? WHERE id = ?')
      .run('2026-10-27T09:15:00.000Z', schedule.id);

    const executor = createGatewayScheduleExecutor({ intervalMs: 60_000, now: () => tickAt });
    expect(await executor.tick()).toBe(1);
    getGatewayDb()
      .prepare('UPDATE gateway_schedules SET next_run_at = ? WHERE id = ?')
      .run('2026-10-27T09:15:00.000Z', schedule.id);
    expect(await executor.tick()).toBe(0);
    expect(listGatewayScheduleRuns(schedule.id)).toHaveLength(1);
  });

  it('creates, lists, updates, pauses, and cancels a schedule for one agent', () => {
    registerWorkspace({
      workspace_id: 'ws-other',
      agent_group_id: 'ag-other',
      name: 'Other Agent',
    });
    const created = applyScheduleAction({
      workspaceId: 'ws-schedule',
      op: 'create',
      prompt: 'Daily summary',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      delivery: { channel_type: 'zoho-cliq', platform_id: 'chat-1', thread_id: null },
    });
    expect(created.ok).toBe(true);
    const schedule = created.data as { id: string };
    expect(applyScheduleAction({ workspaceId: 'ws-other', op: 'list' }).data).toEqual([]);

    const updated = applyScheduleAction({
      workspaceId: 'ws-schedule',
      op: 'update',
      scheduleId: schedule.id,
      prompt: 'Evening summary',
      cronExpression: '30 18 * * 1-5',
    });
    expect(updated.ok).toBe(true);
    expect(getGatewaySchedule(schedule.id)?.prompt).toBe('Evening summary');
    expect(getGatewaySchedule(schedule.id)?.cron_expression).toBe('30 18 * * 1-5');

    expect(
      applyScheduleAction({ workspaceId: 'ws-other', op: 'pause', scheduleId: schedule.id }).ok,
    ).toBe(false);
    expect(applyScheduleAction({ workspaceId: 'ws-schedule', op: 'pause', scheduleId: schedule.id }).ok).toBe(
      true,
    );
    expect(getGatewaySchedule(schedule.id)?.enabled).toBe(false);
    expect(applyScheduleAction({ workspaceId: 'ws-schedule', op: 'resume', scheduleId: schedule.id }).ok).toBe(
      true,
    );
    expect(getGatewaySchedule(schedule.id)?.enabled).toBe(true);

    expect(applyScheduleAction({ workspaceId: 'ws-schedule', op: 'cancel', scheduleId: schedule.id }).ok).toBe(
      true,
    );
    expect(getGatewaySchedule(schedule.id)).toBeNull();
    expect(applyScheduleAction({
      workspaceId: 'ws-schedule',
      op: 'create',
      prompt: 'Bad',
      cronExpression: 'not cron',
      timezone: 'UTC',
      delivery: { channel_type: 'zoho-cliq', platform_id: 'chat-1' },
    }).ok).toBe(false);
  });

  it('keeps a schedule locked after its reply is delivered until the turn finishes', async () => {
    const schedule = createGatewaySchedule({
      id: 'schedule-lock',
      workspace_id: 'ws-schedule',
      prompt: 'Do the scheduled work.',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      delivery: { channel_type: 'zoho-cliq', platform_id: 'chat-1' },
    });
    getGatewayDb()
      .prepare('UPDATE gateway_schedules SET next_run_at = ? WHERE id = ?')
      .run('2026-10-27T09:15:00.000Z', schedule.id);

    const executor = createGatewayScheduleExecutor({ intervalMs: 60_000, now: () => tickAt });
    expect(await executor.tick()).toBe(1);
    const run = listGatewayScheduleRuns(schedule.id)[0]!;
    getGatewayDb().prepare('DELETE FROM customer_messages WHERE id = ?').run(run.inbound_message_id);

    expect(await executor.tick()).toBe(0);
    expect(getGatewaySchedule(schedule.id)?.active_run_id).toBe(run.id);
    expect(listGatewayScheduleRuns(schedule.id)).toHaveLength(1);

    expect(
      finishGatewayScheduleRun(`${run.inbound_message_id}:ag-schedule`, 'completed'),
    ).toBe(true);
    expect(getGatewaySchedule(schedule.id)?.active_run_id).toBeNull();
    expect(listGatewayScheduleRuns(schedule.id)[0]?.status).toBe('completed');
  });
});

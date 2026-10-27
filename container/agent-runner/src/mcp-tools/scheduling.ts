/**
 * Scheduling MCP tools backed by the gateway schedule store.
 *
 * The container cannot write gateway.db. Each tool writes a schedule_request
 * system action; the worker calls the gateway and writes schedule_response.
 */
import { findScheduleResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `schedule-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ScheduleOp = 'create' | 'list' | 'update' | 'cancel' | 'pause' | 'resume';

async function scheduleRoundTrip(
  op: ScheduleOp,
  fields: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const requestId = generateId();
  const routing = getSessionRouting();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({
      action: 'schedule_request',
      requestId,
      op,
      timezone: TIMEZONE,
      channelType: routing.channel_type,
      platformId: routing.platform_id,
      threadId: routing.thread_id,
      ...fields,
    }),
  });

  log(`schedule_request ${op}: ${requestId}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findScheduleResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        const parsed = JSON.parse(response.content) as {
          ok?: boolean;
          data?: unknown;
          error?: string;
        };
        return { ok: Boolean(parsed.ok), data: parsed.data, error: parsed.error };
      } catch {
        return { ok: false, error: 'Invalid schedule_response JSON' };
      }
    }
    await sleep(250);
  }
  return { ok: false, error: `Timed out waiting for schedule_response (${op})` };
}

function formatSchedule(schedule: Record<string, unknown>): string {
  const enabled = schedule.enabled === false ? 'disabled' : 'enabled';
  return `- ${schedule.id} [${enabled}] cron=${schedule.cron_expression} tz=${schedule.timezone} next=${schedule.next_run_at} → ${String(schedule.prompt ?? '').slice(0, 120)}`;
}

function resultText(result: { ok: boolean; data?: unknown; error?: string }, empty: string): ReturnType<typeof ok> {
  if (!result.ok) return err(result.error || 'Schedule request failed');
  if (Array.isArray(result.data)) {
    if (result.data.length === 0) return ok(empty);
    return ok(result.data.map((row) => formatSchedule(row as Record<string, unknown>)).join('\n'));
  }
  if (result.data && typeof result.data === 'object') return ok(formatSchedule(result.data as Record<string, unknown>));
  return ok(empty);
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      'Create a recurring schedule for this agent. Results are delivered back to the current chat. Cron is evaluated in the timezone from the <context timezone="..."/> header. Use list_tasks to see existing schedules before creating a duplicate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'What the agent should do on each run' },
        recurrence: {
          type: 'string',
          description: 'Five-field cron expression, e.g. "0 9 * * 1-5" for weekdays at 9:00',
        },
      },
      required: ['prompt', 'recurrence'],
    },
  },
  async handler(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const recurrence = typeof args.recurrence === 'string' ? args.recurrence.trim() : '';
    if (!prompt || !recurrence) return err('prompt and recurrence are required');
    const result = await scheduleRoundTrip('create', { prompt, cronExpression: recurrence });
    return resultText(result, 'Schedule created.');
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      'List this agent\'s schedules. The id is what update_task, pause_task, resume_task, and cancel_task expect.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return resultText(await scheduleRoundTrip('list', {}), 'No schedules.');
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Change an existing schedule. Pass the id from list_tasks. Omitted fields stay unchanged.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Schedule id from list_tasks' },
        prompt: { type: 'string', description: 'New instructions' },
        recurrence: { type: 'string', description: 'New five-field cron expression' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) return err('taskId is required');
    const fields: Record<string, unknown> = { scheduleId: taskId };
    if (typeof args.prompt === 'string' && args.prompt.trim()) fields.prompt = args.prompt.trim();
    if (typeof args.recurrence === 'string' && args.recurrence.trim()) {
      fields.cronExpression = args.recurrence.trim();
    }
    if (Object.keys(fields).length === 1) return err('prompt or recurrence is required');
    return resultText(await scheduleRoundTrip('update', fields), 'Schedule updated.');
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Disable a schedule so it will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Schedule id from list_tasks' } },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) return err('taskId is required');
    return resultText(await scheduleRoundTrip('pause', { scheduleId: taskId }), 'Schedule paused.');
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Enable a paused schedule.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Schedule id from list_tasks' } },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) return err('taskId is required');
    return resultText(await scheduleRoundTrip('resume', { scheduleId: taskId }), 'Schedule resumed.');
  },
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Delete a schedule. This does not affect the current chat.',
    inputSchema: {
      type: 'object' as const,
      properties: { taskId: { type: 'string', description: 'Schedule id from list_tasks' } },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) return err('taskId is required');
    const result = await scheduleRoundTrip('cancel', { scheduleId: taskId });
    if (!result.ok) return err(result.error || 'Schedule request failed');
    return ok(`Schedule cancelled: ${taskId}`);
  },
};

registerTools([scheduleTask, listTasks, updateTask, pauseTask, resumeTask, cancelTask]);

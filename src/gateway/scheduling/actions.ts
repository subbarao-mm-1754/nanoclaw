import {
  createGatewaySchedule,
  deleteGatewaySchedule,
  getGatewaySchedule,
  listGatewaySchedules,
  setGatewayScheduleEnabled,
  updateGatewaySchedule,
} from './store.js';
import type { GatewaySchedule } from '../types.js';

export type ScheduleActionOp = 'create' | 'list' | 'update' | 'cancel' | 'pause' | 'resume';

export interface ScheduleActionInput {
  workspaceId: string;
  op: ScheduleActionOp;
  scheduleId?: string;
  prompt?: string;
  cronExpression?: string;
  timezone?: string;
  delivery?: {
    channel_type?: string;
    platform_id?: string;
    thread_id?: string | null;
  };
}

export interface ScheduleActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function ownedSchedule(workspaceId: string, scheduleId: string | undefined): GatewaySchedule | null {
  if (!scheduleId) return null;
  const schedule = getGatewaySchedule(scheduleId);
  if (!schedule || schedule.workspace_id !== workspaceId) return null;
  return schedule;
}

/** Apply a chat-originated schedule command to the gateway store. */
export function applyScheduleAction(input: ScheduleActionInput): ScheduleActionResult {
  try {
    switch (input.op) {
      case 'create': {
        const channelType = input.delivery?.channel_type?.trim() ?? '';
        const platformId = input.delivery?.platform_id?.trim() ?? '';
        if (!input.prompt?.trim() || !input.cronExpression?.trim() || !input.timezone?.trim()) {
          return { ok: false, error: 'prompt, cronExpression, and timezone are required' };
        }
        if (!channelType || !platformId) {
          return { ok: false, error: 'The current chat has no delivery address for schedule results' };
        }
        const schedule = createGatewaySchedule({
          workspace_id: input.workspaceId,
          prompt: input.prompt,
          cron_expression: input.cronExpression,
          timezone: input.timezone,
          delivery: {
            channel_type: channelType,
            platform_id: platformId,
            thread_id: input.delivery?.thread_id ?? null,
          },
        });
        return { ok: true, data: schedule };
      }
      case 'list':
        return { ok: true, data: listGatewaySchedules(input.workspaceId) };
      case 'update': {
        const schedule = ownedSchedule(input.workspaceId, input.scheduleId);
        if (!schedule) return { ok: false, error: 'Schedule not found' };
        const updated = updateGatewaySchedule(schedule.id, {
          prompt: input.prompt,
          cron_expression: input.cronExpression,
          timezone: input.timezone,
        });
        return { ok: true, data: updated };
      }
      case 'pause':
      case 'resume': {
        const schedule = ownedSchedule(input.workspaceId, input.scheduleId);
        if (!schedule) return { ok: false, error: 'Schedule not found' };
        setGatewayScheduleEnabled(schedule.id, input.op === 'resume');
        return { ok: true, data: getGatewaySchedule(schedule.id) };
      }
      case 'cancel': {
        const schedule = ownedSchedule(input.workspaceId, input.scheduleId);
        if (!schedule) return { ok: false, error: 'Schedule not found' };
        deleteGatewaySchedule(schedule.id);
        return { ok: true, data: { id: schedule.id, cancelled: true } };
      }
      default:
        return { ok: false, error: 'Unknown schedule action' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

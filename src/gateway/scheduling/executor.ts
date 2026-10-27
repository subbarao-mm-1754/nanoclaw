import { log } from '../../log.js';
import { enqueueInboundMessage } from '../store/messages.js';
import {
  claimDueGatewaySchedule,
  failGatewayScheduleRun,
  markGatewayScheduleRunEnqueued,
  reconcileGatewayScheduleRuns,
} from './store.js';

export interface GatewayScheduleExecutor {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
}

export interface GatewayScheduleExecutorOptions {
  intervalMs: number;
  now?: () => Date;
}

/**
 * Gateway implementation of the scheduling seam. It only translates a due
 * schedule into the existing inbound `task` message contract; it owns no worker
 * or container lifecycle, so another scheduler can replace it later.
 */
export function createGatewayScheduleExecutor(
  options: GatewayScheduleExecutorOptions,
): GatewayScheduleExecutor {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  const clock = options.now ?? (() => new Date());

  async function tick(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    let enqueued = 0;
    try {
      reconcileGatewayScheduleRuns();
      // Claim and enqueue all presently due schedules. Each claim advances the
      // next slot atomically, so a repeated tick cannot emit duplicates.
      for (;;) {
        const claimed = claimDueGatewaySchedule(clock());
        if (!claimed) break;
        const { schedule, run } = claimed;
        try {
          enqueueInboundMessage(
            {
              id: run.inbound_message_id,
              channel_type: schedule.channel_type,
              platform_id: schedule.platform_id,
              thread_id: schedule.thread_id,
              kind: 'task',
              content: {
                prompt: schedule.prompt,
                scheduleId: schedule.id,
                runId: run.id,
              },
              timestamp: run.scheduled_for,
            },
            schedule.conversation_id,
          );
          markGatewayScheduleRunEnqueued(run.id);
          enqueued++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failGatewayScheduleRun(run.id, message);
          log.error('Gateway schedule enqueue failed', { scheduleId: schedule.id, runId: run.id, err });
        }
      }
    } finally {
      ticking = false;
    }
    return enqueued;
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), options.intervalMs);
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref?.();
      }
      void tick();
      log.info('Gateway schedule executor started', { intervalMs: options.intervalMs });
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

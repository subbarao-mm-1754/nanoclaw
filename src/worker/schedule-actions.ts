/**
 * Worker-side proxy for container schedule_request system actions.
 *
 * The container cannot write gateway.db. Outbound collection calls the gateway
 * schedule store and writes schedule_response into inbound.db for the MCP tool.
 */
import { GATEWAY_PUBLIC_URL, WORKER_AUTH_TOKEN } from '../config.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';

const SCHEDULE_OPS = new Set(['create', 'list', 'update', 'cancel', 'pause', 'resume']);

function isScheduleRequest(content: Record<string, unknown>): boolean {
  return (
    content.action === 'schedule_request' &&
    typeof content.requestId === 'string' &&
    typeof content.op === 'string' &&
    SCHEDULE_OPS.has(content.op)
  );
}

export async function handleScheduleSystemMessage(opts: {
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  rawContent: string;
}): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(opts.rawContent) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!isScheduleRequest(parsed)) return false;

  const requestId = parsed.requestId as string;
  const result = await callGatewaySchedule({
    workspaceId: opts.workspaceId,
    op: parsed.op,
    scheduleId: typeof parsed.scheduleId === 'string' ? parsed.scheduleId : undefined,
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
    cronExpression: typeof parsed.cronExpression === 'string' ? parsed.cronExpression : undefined,
    timezone: typeof parsed.timezone === 'string' ? parsed.timezone : undefined,
    delivery: {
      channel_type: typeof parsed.channelType === 'string' ? parsed.channelType : undefined,
      platform_id: typeof parsed.platformId === 'string' ? parsed.platformId : undefined,
      thread_id: typeof parsed.threadId === 'string' ? parsed.threadId : null,
    },
  });

  const inDb = openInboundDb(opts.agentGroupId, opts.sessionId);
  try {
    insertMessage(inDb, {
      id: `schedule-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'schedule_response',
        requestId,
        ...result,
      }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } finally {
    inDb.close();
  }

  log.info('Worker handled schedule_request', {
    requestId,
    op: parsed.op,
    workspaceId: opts.workspaceId,
    ok: result.ok,
  });
  return true;
}

/** Tell the gateway a schedule container turn reached a terminal processing_ack. */
export async function reportScheduleRunFinished(input: {
  inboundMessageId: string;
  status: 'completed' | 'failed';
  error?: string;
}): Promise<'ok' | 'missing'> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/schedules/finish`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (res.status === 404) return 'missing';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Schedule finish HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return 'ok';
}

async function callGatewaySchedule(body: Record<string, unknown>): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/schedules`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: { ok?: boolean; data?: unknown; error?: string };
    try {
      json = JSON.parse(text) as { ok?: boolean; data?: unknown; error?: string };
    } catch {
      return { ok: false, error: `Gateway schedule non-JSON (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok || json.ok === false) {
      return { ok: false, error: json.error || `Gateway HTTP ${res.status}` };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Gateway schedule call failed: ${message}` };
  }
}

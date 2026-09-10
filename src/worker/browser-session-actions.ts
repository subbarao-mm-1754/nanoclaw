/**
 * Worker-side proxy for container browser_session_request system actions.
 *
 * Flow: MCP tool → messages_out → here → Gateway internal API → headed login
 * + Cliq notify. Response written back to inbound.db for the MCP tool.
 */
import { GATEWAY_PUBLIC_URL, WORKER_AUTH_TOKEN } from '../config.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';
import type { WorkerDelivery } from './types.js';

export type BrowserSessionSystemContent = {
  action: 'browser_session_request';
  requestId: string;
  origin: string;
  label?: string;
  login_url?: string;
  /** When not false, gateway opens headed login even if a stale session exists. */
  force?: boolean;
};

function isBrowserSessionRequest(
  content: Record<string, unknown>,
): content is BrowserSessionSystemContent {
  return (
    content.action === 'browser_session_request' &&
    typeof content.requestId === 'string' &&
    typeof content.origin === 'string'
  );
}

export async function handleBrowserSessionSystemMessage(opts: {
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  /** When null, gateway still opens headed login; Cliq/confirm notify is skipped. */
  delivery: WorkerDelivery | null;
  rawContent: string;
}): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(opts.rawContent) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!isBrowserSessionRequest(parsed)) return false;

  const requestId = parsed.requestId;
  const notify =
    opts.delivery?.channel_type && opts.delivery.platform_id
      ? {
          channel_type: opts.delivery.channel_type,
          platform_id: opts.delivery.platform_id,
          thread_id: opts.delivery.thread_id,
        }
      : undefined;
  if (!notify) {
    log.warn('browser_session_request missing notify delivery; opening login without channel ping', {
      requestId,
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
    });
  }
  const result = await callGatewayBrowserSessionRequest({
    workspace_id: opts.workspaceId,
    origin: parsed.origin,
    label: parsed.label,
    login_url: parsed.login_url,
    // Agent only requests when login is needed — never silently reuse expired cookies.
    force: parsed.force !== false,
    ...(notify ? { notify } : {}),
  });

  const inDb = openInboundDb(opts.agentGroupId, opts.sessionId);
  try {
    insertMessage(inDb, {
      id: `browser-session-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'browser_session_response',
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

  log.info('Worker handled browser_session_request', {
    requestId,
    workspaceId: opts.workspaceId,
    ok: result.ok,
  });
  return true;
}

async function callGatewayBrowserSessionRequest(body: Record<string, unknown>): Promise<{
  ok: boolean;
  reused?: boolean;
  session_id?: string;
  connect_url?: string | null;
  message?: string;
  error?: string;
}> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/browser-sessions/request`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: {
      ok?: boolean;
      reused?: boolean;
      session_id?: string;
      connect_url?: string | null;
      message?: string;
      error?: string;
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { ok: false, error: `Gateway non-JSON (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { ok: false, error: json.error || `Gateway HTTP ${res.status}` };
    }
    return {
      ok: Boolean(json.ok),
      reused: json.reused,
      session_id: json.session_id,
      connect_url: json.connect_url,
      message: json.message,
      error: json.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Gateway browser-session call failed: ${message}` };
  }
}

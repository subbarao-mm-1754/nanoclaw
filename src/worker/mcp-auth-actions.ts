/**
 * Worker-side proxy for container mcp_auth_request system actions.
 *
 * Flow: request_mcp_auth MCP tool → messages_out → here → Gateway internal API
 * → startOAuthConnect + Cliq notify. Response written to inbound.db.
 */
import { GATEWAY_PUBLIC_URL, WORKER_AUTH_TOKEN } from '../config.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';
import type { WorkerDelivery } from './types.js';

export type McpAuthSystemContent = {
  action: 'mcp_auth_request';
  requestId: string;
  mcp_url?: string;
  mcp_server_name?: string;
};

function isMcpAuthRequest(content: Record<string, unknown>): content is McpAuthSystemContent {
  return content.action === 'mcp_auth_request' && typeof content.requestId === 'string';
}

export async function handleMcpAuthSystemMessage(opts: {
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  delivery: WorkerDelivery | null;
  rawContent: string;
}): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(opts.rawContent) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!isMcpAuthRequest(parsed)) return false;

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
    log.warn('mcp_auth_request missing notify delivery; starting OAuth without channel ping', {
      requestId,
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
    });
  }

  const result = await callGatewayMcpAuthRequest({
    workspace_id: opts.workspaceId,
    mcp_url: typeof parsed.mcp_url === 'string' ? parsed.mcp_url : undefined,
    mcp_server_name:
      typeof parsed.mcp_server_name === 'string' ? parsed.mcp_server_name : undefined,
    ...(notify ? { notify } : {}),
  });

  const inDb = openInboundDb(opts.agentGroupId, opts.sessionId);
  try {
    insertMessage(inDb, {
      id: `mcp-auth-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'mcp_auth_response',
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

  log.info('Worker handled mcp_auth_request', {
    requestId,
    workspaceId: opts.workspaceId,
    ok: result.ok,
    reused: result.reused,
  });
  return true;
}

async function callGatewayMcpAuthRequest(body: Record<string, unknown>): Promise<{
  ok: boolean;
  reused?: boolean;
  authorize_url?: string | null;
  mcp_url?: string | null;
  provider?: string;
  connection_id?: string;
  message?: string;
  error?: string;
}> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/mcp-auth/request`;
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
      authorize_url?: string | null;
      mcp_url?: string | null;
      provider?: string;
      connection_id?: string;
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
      authorize_url: json.authorize_url,
      mcp_url: json.mcp_url,
      provider: json.provider,
      connection_id: json.connection_id,
      message: json.message,
      error: json.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Gateway mcp-auth call failed: ${message}` };
  }
}

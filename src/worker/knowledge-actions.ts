/**
 * Worker-side proxy for container knowledge_request system actions.
 *
 * Containers cannot reach Postgres. During outbound collection the worker
 * detects knowledge_request, calls the Gateway internal API, and writes
 * knowledge_response into inbound.db for the blocking MCP tool to read.
 */
import {
  GATEWAY_PUBLIC_URL,
  WORKER_AUTH_TOKEN,
} from '../config.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';
import type { KnowledgeOp } from '../knowledge/store.js';

export type KnowledgeSystemContent = {
  action: 'knowledge_request';
  requestId: string;
  op: KnowledgeOp;
  path?: string;
  title?: string;
  content?: string;
  query?: string;
  prefix?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
};

function isKnowledgeRequest(content: Record<string, unknown>): content is KnowledgeSystemContent {
  return content.action === 'knowledge_request' && typeof content.requestId === 'string';
}

export async function handleKnowledgeSystemMessage(opts: {
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
  if (!isKnowledgeRequest(parsed)) return false;

  const requestId = parsed.requestId;
  const result = await callGatewayKnowledge({
    workspace_id: opts.workspaceId,
    op: parsed.op,
    path: parsed.path,
    title: parsed.title,
    content: parsed.content,
    query: parsed.query,
    prefix: parsed.prefix,
    limit: parsed.limit,
    metadata: parsed.metadata,
  });

  const inDb = openInboundDb(opts.agentGroupId, opts.sessionId);
  try {
    insertMessage(inDb, {
      id: `knowledge-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'knowledge_response',
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

  log.info('Worker handled knowledge_request', {
    requestId,
    op: parsed.op,
    workspaceId: opts.workspaceId,
    ok: result.ok,
  });
  return true;
}

async function callGatewayKnowledge(body: Record<string, unknown>): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/knowledge`;
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
      return { ok: false, error: `Gateway knowledge non-JSON (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { ok: false, error: json.error || `Gateway HTTP ${res.status}` };
    }
    return { ok: Boolean(json.ok), data: json.data, error: json.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Gateway knowledge call failed: ${message}` };
  }
}

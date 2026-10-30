/**
 * Worker proxy for orchestration_read_artifact.
 * The container never sees gateway.db. The worker supplies the session workspace id.
 */
import { GATEWAY_PUBLIC_URL, WORKER_AUTH_TOKEN } from '../config.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb } from '../session-manager.js';

type ArtifactRequest = {
  action: 'orchestration_artifact_request';
  requestId: string;
  artifact_id: string;
};

function isArtifactRequest(content: Record<string, unknown>): content is ArtifactRequest {
  return (
    content.action === 'orchestration_artifact_request' &&
    typeof content.requestId === 'string' &&
    typeof content.artifact_id === 'string'
  );
}

export async function handleArtifactSystemMessage(opts: {
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
  if (!isArtifactRequest(parsed)) return false;

  const requestId = parsed.requestId;
  const result = await callGatewayArtifact({
    workspace_id: opts.workspaceId,
    artifact_id: parsed.artifact_id,
  });

  const inDb = openInboundDb(opts.agentGroupId, opts.sessionId);
  try {
    insertMessage(inDb, {
      id: `oart-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'orchestration_artifact_response',
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

  log.info('Worker handled orchestration_artifact_request', {
    requestId,
    workspaceId: opts.workspaceId,
    ok: result.ok,
  });
  return true;
}

async function callGatewayArtifact(body: Record<string, unknown>): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/internal/orchestration-artifacts`;
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
      return { ok: false, error: `Gateway artifact non-JSON (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) return { ok: false, error: json.error || `Gateway HTTP ${res.status}` };
    return { ok: Boolean(json.ok), data: json.data, error: json.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Gateway artifact call failed: ${message}` };
  }
}

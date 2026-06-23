import { getGatewayDb } from '../db/connection.js';

export interface HttpOutboundRecord {
  id: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  content: Record<string, unknown>;
  files?: Array<{ filename: string; data_base64: string }>;
}

export interface HttpResponseRecord {
  inbound_id: string;
  platform_id: string;
  thread_id: string | null;
  conversation_id: string | null;
  worker_job_id: string | null;
  outbound: HttpOutboundRecord[];
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function saveHttpResponse(input: {
  inbound_id: string;
  platform_id: string;
  thread_id: string | null;
  conversation_id?: string;
  worker_job_id?: string;
  outbound: HttpOutboundRecord[];
}): void {
  getGatewayDb()
    .prepare(
      `INSERT INTO http_responses
        (inbound_id, platform_id, thread_id, conversation_id, worker_job_id, outbound_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(inbound_id) DO UPDATE SET
         outbound_json = excluded.outbound_json,
         worker_job_id = excluded.worker_job_id,
         created_at = excluded.created_at`,
    )
    .run(
      input.inbound_id,
      input.platform_id,
      input.thread_id,
      input.conversation_id ?? null,
      input.worker_job_id ?? null,
      JSON.stringify(input.outbound),
      now(),
    );
}

export function getHttpResponse(inboundId: string): HttpResponseRecord | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM http_responses WHERE inbound_id = ?')
    .get(inboundId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    inbound_id: row.inbound_id as string,
    platform_id: row.platform_id as string,
    thread_id: (row.thread_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    worker_job_id: (row.worker_job_id as string | null) ?? null,
    outbound: JSON.parse(row.outbound_json as string) as HttpOutboundRecord[],
    created_at: row.created_at as string,
  };
}

export function listHttpResponses(platformId: string, limit = 20): HttpResponseRecord[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM http_responses WHERE platform_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(platformId, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    inbound_id: row.inbound_id as string,
    platform_id: row.platform_id as string,
    thread_id: (row.thread_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    worker_job_id: (row.worker_job_id as string | null) ?? null,
    outbound: JSON.parse(row.outbound_json as string) as HttpOutboundRecord[],
    created_at: row.created_at as string,
  }));
}

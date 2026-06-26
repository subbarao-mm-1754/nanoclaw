import { getGatewayDb } from '../db/connection.js';
import type { CustomerMessage, InboundEnqueueInput, MessageStatus } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function rowToMessage(row: Record<string, unknown>): CustomerMessage {
  return {
    id: row.id as string,
    direction: row.direction as CustomerMessage['direction'],
    status: row.status as CustomerMessage['status'],
    channel_type: row.channel_type as string,
    platform_id: row.platform_id as string,
    thread_id: (row.thread_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    kind: row.kind as string,
    content_json: row.content_json as string,
    sender_id: (row.sender_id as string | null) ?? null,
    sender_display_name: (row.sender_display_name as string | null) ?? null,
    files_json: (row.files_json as string | null) ?? null,
    worker_job_id: (row.worker_job_id as string | null) ?? null,
    worker_status: (row.worker_status as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function enqueueInboundMessage(
  input: InboundEnqueueInput,
  conversationId: string,
): CustomerMessage {
  const existing = getMessage(input.id);
  if (
    existing?.direction === 'inbound' &&
    (existing.status === 'pending' ||
      existing.status === 'processing' ||
      existing.status === 'failed')
  ) {
    return existing;
  }

  const ts = now();
  const db = getGatewayDb();
  try {
    db.prepare(
      `INSERT INTO customer_messages
        (id, direction, status, channel_type, platform_id, thread_id, conversation_id,
         kind, content_json, sender_id, sender_display_name, created_at, updated_at)
       VALUES (?, 'inbound', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.channel_type,
      input.platform_id,
      input.thread_id,
      conversationId,
      input.kind,
      JSON.stringify(input.content),
      input.sender_id ?? null,
      input.sender_display_name ?? null,
      ts,
      ts,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      const row = getMessage(input.id);
      if (row) return row;
    }
    throw err;
  }
  return getMessage(input.id)!;
}

export function insertOutboundMessage(input: {
  id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  conversation_id: string;
  kind: string;
  content: unknown;
  files?: Array<{ filename: string; data_base64: string }>;
  worker_job_id: string;
}): CustomerMessage {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO customer_messages
        (id, direction, status, channel_type, platform_id, thread_id, conversation_id,
         kind, content_json, files_json, worker_job_id, created_at, updated_at)
       VALUES (?, 'outbound', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.channel_type,
      input.platform_id,
      input.thread_id,
      input.conversation_id,
      input.kind,
      JSON.stringify(input.content),
      input.files ? JSON.stringify(input.files) : null,
      input.worker_job_id,
      ts,
      ts,
    );
  return getMessage(input.id)!;
}

export function claimNextInbound(): CustomerMessage | null {
  const db = getGatewayDb();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM customer_messages
         WHERE direction = 'inbound' AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;

    const ts = now();
    db.prepare(`UPDATE customer_messages SET status = 'processing', updated_at = ? WHERE id = ?`).run(
      ts,
      row.id,
    );
    return rowToMessage({ ...row, status: 'processing', updated_at: ts });
  })();
}

export function updateMessageStatus(
  id: string,
  status: MessageStatus,
  extra?: { worker_job_id?: string; worker_status?: string; error?: string },
): void {
  getGatewayDb()
    .prepare(
      `UPDATE customer_messages
       SET status = ?, worker_job_id = COALESCE(?, worker_job_id),
           worker_status = COALESCE(?, worker_status),
           error = COALESCE(?, error), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      extra?.worker_job_id ?? null,
      extra?.worker_status ?? null,
      extra?.error ?? null,
      now(),
      id,
    );
}

export function deleteMessages(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getGatewayDb().prepare(`DELETE FROM customer_messages WHERE id IN (${placeholders})`).run(...ids);
}

export function getMessage(id: string): CustomerMessage | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM customer_messages WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export function listPendingMessages(direction: 'inbound' | 'outbound'): CustomerMessage[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM customer_messages WHERE direction = ? AND status = 'pending' ORDER BY created_at ASC`,
    )
    .all(direction) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function countMessagesByStatus(): Record<MessageStatus, number> {
  const rows = getGatewayDb()
    .prepare(`SELECT status, COUNT(*) AS c FROM customer_messages GROUP BY status`)
    .all() as { status: MessageStatus; c: number }[];
  const counts: Record<MessageStatus, number> = {
    pending: 0,
    processing: 0,
    delivered: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] = row.c;
  return counts;
}

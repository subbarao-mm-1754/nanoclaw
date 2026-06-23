import { getGatewayDb } from '../db/connection.js';
import type { ChannelConnection, ChannelConnectionStatus } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function rowToConnection(row: Record<string, unknown>): ChannelConnection {
  return {
    channel_type: row.channel_type as string,
    display_name: (row.display_name as string | null) ?? null,
    status: row.status as ChannelConnectionStatus,
    connected_at: (row.connected_at as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    updated_at: row.updated_at as string,
  };
}

export function upsertChannelConnection(
  channelType: string,
  status: ChannelConnectionStatus,
  displayName?: string,
  error?: string,
): void {
  const ts = now();
  const db = getGatewayDb();
  db.prepare(
    `INSERT INTO channel_connections (channel_type, display_name, status, connected_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_type) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, channel_connections.display_name),
       status = excluded.status,
       connected_at = CASE WHEN excluded.status = 'connected' THEN excluded.connected_at ELSE channel_connections.connected_at END,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    channelType,
    displayName ?? null,
    status,
    status === 'connected' ? ts : null,
    error ?? null,
    ts,
  );
}

export function listChannelConnections(): ChannelConnection[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM channel_connections ORDER BY channel_type')
    .all() as Record<string, unknown>[];
  return rows.map(rowToConnection);
}

export function getChannelConnection(channelType: string): ChannelConnection | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM channel_connections WHERE channel_type = ?')
    .get(channelType) as Record<string, unknown> | undefined;
  return row ? rowToConnection(row) : null;
}

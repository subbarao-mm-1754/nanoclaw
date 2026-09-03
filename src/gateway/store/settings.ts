/**
 * Gateway operator settings (shared secrets / config).
 * Stored in gateway.db — not in the git repo, not in `.env`.
 */
import { getGatewayDb } from '../db/connection.js';

function now(): string {
  return new Date().toISOString();
}

export function getGatewaySetting(key: string): string | null {
  const row = getGatewayDb()
    .prepare('SELECT value FROM gateway_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setGatewaySetting(key: string, value: string): void {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, value, ts);
}

export function deleteGatewaySetting(key: string): void {
  getGatewayDb().prepare('DELETE FROM gateway_settings WHERE key = ?').run(key);
}

import { getGatewayDb } from '../db/connection.js';
import type { GatewayWorkspace } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function rowToWorkspace(row: Record<string, unknown>): GatewayWorkspace {
  return {
    workspace_id: row.workspace_id as string,
    agent_group_id: row.agent_group_id as string,
    name: row.name as string,
    is_default: Boolean(row.is_default),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function registerWorkspace(input: {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  is_default?: boolean;
}): GatewayWorkspace {
  const db = getGatewayDb();
  const ts = now();
  const isDefault = input.is_default ? 1 : 0;

  return db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE gateway_workspaces SET is_default = 0, updated_at = ? WHERE is_default = 1').run(ts);
    }
    db.prepare(
      `INSERT INTO gateway_workspaces (workspace_id, agent_group_id, name, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         agent_group_id = excluded.agent_group_id,
         name = excluded.name,
         is_default = excluded.is_default,
         updated_at = excluded.updated_at`,
    ).run(input.workspace_id, input.agent_group_id, input.name, isDefault, ts, ts);

    return getWorkspace(input.workspace_id)!;
  })();
}

export function getWorkspace(workspaceId: string): GatewayWorkspace | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function getDefaultWorkspace(): GatewayWorkspace | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces WHERE is_default = 1 LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function listWorkspaces(): GatewayWorkspace[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces ORDER BY is_default DESC, name')
    .all() as Record<string, unknown>[];
  return rows.map(rowToWorkspace);
}

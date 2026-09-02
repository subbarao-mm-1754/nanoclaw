import type { ContainerConfigSnapshot } from '../../container-config.js';
import { getGatewayDb } from '../db/connection.js';
import type { GatewayWorkspace } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function parseContainerConfig(json: string | null): ContainerConfigSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ContainerConfigSnapshot;
  } catch {
    return null;
  }
}

function rowToWorkspace(row: Record<string, unknown>): GatewayWorkspace {
  return {
    workspace_id: row.workspace_id as string,
    agent_group_id: row.agent_group_id as string,
    name: row.name as string,
    is_default: Boolean(row.is_default),
    owner_user_id: (row.owner_user_id as string | null) ?? null,
    folder: (row.folder as string | null) ?? null,
    cli_scope: (row.cli_scope as string) || 'group',
    container_config: parseContainerConfig(row.container_config_json as string | null),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function registerWorkspace(input: {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  is_default?: boolean;
  owner_user_id?: string;
  folder?: string;
  cli_scope?: string;
  container_config?: ContainerConfigSnapshot;
}): GatewayWorkspace {
  const db = getGatewayDb();
  const ts = now();
  const isDefault = input.is_default ? 1 : 0;

  return db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE gateway_workspaces SET is_default = 0, updated_at = ? WHERE is_default = 1').run(ts);
    }
    db.prepare(
      `INSERT INTO gateway_workspaces (
         workspace_id, agent_group_id, name, is_default,
         owner_user_id, folder, cli_scope, container_config_json,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         agent_group_id = excluded.agent_group_id,
         name = excluded.name,
         is_default = excluded.is_default,
         owner_user_id = COALESCE(excluded.owner_user_id, gateway_workspaces.owner_user_id),
         folder = COALESCE(excluded.folder, gateway_workspaces.folder),
         cli_scope = COALESCE(excluded.cli_scope, gateway_workspaces.cli_scope),
         container_config_json = COALESCE(excluded.container_config_json, gateway_workspaces.container_config_json),
         updated_at = excluded.updated_at`,
    ).run(
      input.workspace_id,
      input.agent_group_id,
      input.name,
      isDefault,
      input.owner_user_id ?? null,
      input.folder ?? null,
      input.cli_scope ?? 'group',
      input.container_config ? JSON.stringify(input.container_config) : null,
      ts,
      ts,
    );

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

export function listAgentsForUser(userId: string): GatewayWorkspace[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces WHERE owner_user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToWorkspace);
}

export function deleteWorkspace(workspaceId: string): void {
  const db = getGatewayDb();
  const result = db.prepare('DELETE FROM gateway_workspaces WHERE workspace_id = ?').run(workspaceId);
  if (result.changes === 0) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
}

export function updateWorkspaceMetadata(
  workspaceId: string,
  input: { name?: string; container_config?: ContainerConfigSnapshot; cli_scope?: string; is_default?: boolean },
): GatewayWorkspace {
  const db = getGatewayDb();
  const ts = now();
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error('Workspace not found');

  const isDefault =
    input.is_default === true ? 1 : input.is_default === false ? 0 : workspace.is_default ? 1 : 0;

  return db.transaction(() => {
    if (input.is_default === true) {
      db.prepare('UPDATE gateway_workspaces SET is_default = 0, updated_at = ? WHERE is_default = 1').run(ts);
    }
    db.prepare(
      `UPDATE gateway_workspaces SET
         name = COALESCE(?, name),
         cli_scope = COALESCE(?, cli_scope),
         container_config_json = COALESCE(?, container_config_json),
         is_default = ?,
         updated_at = ?
       WHERE workspace_id = ?`,
    ).run(
      input.name ?? null,
      input.cli_scope ?? null,
      input.container_config ? JSON.stringify(input.container_config) : null,
      isDefault,
      ts,
      workspaceId,
    );
    return getWorkspace(workspaceId)!;
  })();
}

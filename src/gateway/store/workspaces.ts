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
  const kind = row.agent_kind === 'orchestrator' ? 'orchestrator' : 'agent';
  return {
    workspace_id: row.workspace_id as string,
    agent_group_id: row.agent_group_id as string,
    name: row.name as string,
    is_default: Boolean(row.is_default),
    is_master: Boolean(row.is_master),
    owner_user_id: (row.owner_user_id as string | null) ?? null,
    folder: (row.folder as string | null) ?? null,
    cli_scope: (row.cli_scope as string) || 'group',
    container_config: parseContainerConfig(row.container_config_json as string | null),
    worker_content_hash: (row.worker_content_hash as string | null) ?? null,
    agent_kind: kind,
    routing_description: (row.routing_description as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function clearDefaultsForOwner(db: ReturnType<typeof getGatewayDb>, ownerUserId: string | null, ts: string): void {
  // Never clear the per-user master agent — it stays the catch-all default.
  if (ownerUserId) {
    db.prepare(
      `UPDATE gateway_workspaces SET is_default = 0, updated_at = ?
       WHERE owner_user_id = ? AND is_default = 1 AND is_master = 0`,
    ).run(ts, ownerUserId);
  } else {
    db.prepare(
      `UPDATE gateway_workspaces SET is_default = 0, updated_at = ?
       WHERE owner_user_id IS NULL AND is_default = 1 AND is_master = 0`,
    ).run(ts);
  }
}

export function registerWorkspace(input: {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  is_default?: boolean;
  is_master?: boolean;
  owner_user_id?: string;
  folder?: string;
  cli_scope?: string;
  container_config?: ContainerConfigSnapshot;
  agent_kind?: 'agent' | 'orchestrator';
  routing_description?: string | null;
}): GatewayWorkspace {
  const db = getGatewayDb();
  const ts = now();
  const isMaster = input.is_master ? 1 : 0;
  const agentKind = input.agent_kind === 'orchestrator' ? 'orchestrator' : 'agent';
  const ownerUserId = input.owner_user_id ?? null;
  // Master is the sole per-user default; other agents cannot take the flag while a master exists.
  let isDefault = input.is_default || isMaster ? 1 : 0;
  if (isDefault && !isMaster && ownerUserId) {
    const existingMaster = getMasterWorkspaceForUser(ownerUserId);
    if (existingMaster) isDefault = 0;
  }

  return db.transaction(() => {
    if (isDefault) {
      clearDefaultsForOwner(db, ownerUserId, ts);
    }
    const routingDescription =
      input.routing_description !== undefined
        ? input.routing_description?.trim() || null
        : null;

    db.prepare(
      `INSERT INTO gateway_workspaces (
         workspace_id, agent_group_id, name, is_default, is_master,
         owner_user_id, folder, cli_scope, container_config_json,
         agent_kind, routing_description, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         agent_group_id = excluded.agent_group_id,
         name = excluded.name,
         is_default = excluded.is_default,
         is_master = excluded.is_master,
         owner_user_id = COALESCE(excluded.owner_user_id, gateway_workspaces.owner_user_id),
         folder = COALESCE(excluded.folder, gateway_workspaces.folder),
         cli_scope = COALESCE(excluded.cli_scope, gateway_workspaces.cli_scope),
         container_config_json = COALESCE(excluded.container_config_json, gateway_workspaces.container_config_json),
         agent_kind = excluded.agent_kind,
         routing_description = COALESCE(excluded.routing_description, gateway_workspaces.routing_description),
         updated_at = excluded.updated_at`,
    ).run(
      input.workspace_id,
      input.agent_group_id,
      input.name,
      isDefault,
      isMaster,
      ownerUserId,
      input.folder ?? null,
      input.cli_scope ?? 'group',
      input.container_config ? JSON.stringify(input.container_config) : null,
      agentKind,
      routingDescription,
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

export function getWorkspaceByAgentGroupId(agentGroupId: string): GatewayWorkspace | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces WHERE agent_group_id = ? LIMIT 1')
    .get(agentGroupId) as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : null;
}

/** Install-wide default (legacy env seed / owner-less workspace). */
export function getDefaultWorkspace(): GatewayWorkspace | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_workspaces WHERE is_default = 1 LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return row ? rowToWorkspace(row) : null;
}

/** Prefer the user's master agent, then their is_default agent, then newest. */
export function getDefaultWorkspaceForUser(userId: string): GatewayWorkspace | null {
  const agents = listAgentsForUser(userId);
  return (
    agents.find((a) => a.is_master) ??
    agents.find((a) => a.is_default) ??
    agents[0] ??
    null
  );
}

export function getMasterWorkspaceForUser(userId: string): GatewayWorkspace | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_workspaces
       WHERE owner_user_id = ? AND is_master = 1
       LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
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
  input: {
    name?: string;
    container_config?: ContainerConfigSnapshot;
    cli_scope?: string;
    is_default?: boolean;
    routing_description?: string | null;
  },
): GatewayWorkspace {
  const db = getGatewayDb();
  const ts = now();
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error('Workspace not found');

  // Master agent must remain the user's default catch-all.
  let isDefault =
    input.is_default === true ? 1 : input.is_default === false ? 0 : workspace.is_default ? 1 : 0;
  if (workspace.is_master) {
    isDefault = 1;
  } else if (isDefault && workspace.owner_user_id) {
    const master = getMasterWorkspaceForUser(workspace.owner_user_id);
    if (master && master.workspace_id !== workspaceId) isDefault = 0;
  }

  const routingDescription =
    input.routing_description !== undefined
      ? input.routing_description?.trim() || null
      : workspace.routing_description;

  return db.transaction(() => {
    if (isDefault) {
      clearDefaultsForOwner(db, workspace.owner_user_id, ts);
    }
    db.prepare(
      `UPDATE gateway_workspaces SET
         name = COALESCE(?, name),
         cli_scope = COALESCE(?, cli_scope),
         container_config_json = COALESCE(?, container_config_json),
         is_default = ?,
         routing_description = ?,
         updated_at = ?
       WHERE workspace_id = ?`,
    ).run(
      input.name ?? null,
      input.cli_scope ?? null,
      input.container_config ? JSON.stringify(input.container_config) : null,
      isDefault,
      routingDescription,
      ts,
      workspaceId,
    );
    return getWorkspace(workspaceId)!;
  })();
}

/** Cache the Worker-acknowledged content hash so steady-state inbound can skip prepare HTTP. */
export function setWorkerContentHash(workspaceId: string, contentHash: string | null): void {
  const db = getGatewayDb();
  const result = db
    .prepare(
      `UPDATE gateway_workspaces
       SET worker_content_hash = ?, updated_at = ?
       WHERE workspace_id = ?`,
    )
    .run(contentHash, now(), workspaceId);
  if (result.changes === 0) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
}

export function clearWorkerContentHash(workspaceId: string): void {
  setWorkerContentHash(workspaceId, null);
}

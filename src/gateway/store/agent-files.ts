import type { ContainerConfigSnapshot } from '../../container-config.js';
import { getGatewayDb } from '../db/connection.js';
import type { GatewayAgentFile } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function listAgentFiles(workspaceId: string): GatewayAgentFile[] {
  const rows = getGatewayDb()
    .prepare('SELECT path, content FROM gateway_agent_files WHERE workspace_id = ? ORDER BY path')
    .all(workspaceId) as Array<{ path: string; content: string }>;
  return rows;
}

export function saveAgentFiles(workspaceId: string, files: GatewayAgentFile[]): void {
  const db = getGatewayDb();
  const ts = now();
  const insert = db.prepare(
    `INSERT INTO gateway_agent_files (workspace_id, path, content, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, path) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const file of files) {
      insert.run(workspaceId, normalizePath(file.path), file.content, ts);
    }
  })();
}

/** Merge partial file updates into the stored set (attachments win on duplicate paths). */
export function mergeAgentFiles(existing: GatewayAgentFile[], updates: GatewayAgentFile[]): GatewayAgentFile[] {
  const byPath = new Map<string, GatewayAgentFile>();
  for (const file of existing) byPath.set(normalizePath(file.path), { path: normalizePath(file.path), content: file.content });
  for (const file of updates) byPath.set(normalizePath(file.path), { path: normalizePath(file.path), content: file.content });
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function defaultContainerConfig(name: string): ContainerConfigSnapshot {
  return {
    provider: 'claude',
    skills: 'all',
    assistantName: name,
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
  };
}

export class AgentAccessError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'AgentAccessError';
  }
}

export function assertAgentOwner(workspaceId: string, userId: string): void {
  const row = getGatewayDb()
    .prepare('SELECT owner_user_id FROM gateway_workspaces WHERE workspace_id = ?')
    .get(workspaceId) as { owner_user_id: string | null } | undefined;
  if (!row) throw new AgentAccessError('Agent not found', 404);
  if (row.owner_user_id !== userId) {
    throw new AgentAccessError('Only the agent creator can modify this agent');
  }
}

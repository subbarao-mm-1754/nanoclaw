import type { DestinationRow } from '../../db/session-db.js';
import { getGatewayDb } from '../db/connection.js';
import { getWorkspace } from '../store/workspaces.js';
import { isMultiAgentOrchestrationEnabled } from './config.js';
import { listOrchestratorMembers } from './store.js';

/** Extra agent destinations for an orchestrator workspace (Worker process-message). */
export function orchestratorDestinationRows(workspaceId: string): DestinationRow[] {
  if (!isMultiAgentOrchestrationEnabled()) return [];
  const ws = getWorkspace(workspaceId);
  if (!ws || ws.agent_kind !== 'orchestrator') return [];

  return listOrchestratorMembers(workspaceId).map((m) => ({
    name: m.local_name,
    display_name: m.role || m.local_name,
    type: 'agent' as const,
    channel_type: null,
    platform_id: null,
    agent_group_id: m.member_agent_group_id,
  }));
}

/** Parent destination so a specialist can reply to its orchestrator. */
export function parentOrchestratorDestinationRows(memberWorkspaceId: string): DestinationRow[] {
  if (!isMultiAgentOrchestrationEnabled()) return [];
  const rows = getGatewayDb()
    .prepare(
      `SELECT m.orchestrator_workspace_id, w.agent_group_id, w.name
       FROM gateway_orchestrator_members m
       JOIN gateway_workspaces w ON w.workspace_id = m.orchestrator_workspace_id
       WHERE m.member_workspace_id = ?`,
    )
    .all(memberWorkspaceId) as Array<{
    orchestrator_workspace_id: string;
    agent_group_id: string;
    name: string;
  }>;

  return rows.map((r) => ({
    name: 'orchestrator',
    display_name: r.name,
    type: 'agent' as const,
    channel_type: null,
    platform_id: null,
    agent_group_id: r.agent_group_id,
  }));
}

export function extraDestinationsForWorkspace(workspaceId: string): DestinationRow[] {
  const out = [
    ...orchestratorDestinationRows(workspaceId),
    ...parentOrchestratorDestinationRows(workspaceId),
  ];
  const seen = new Set<string>();
  return out.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });
}

import { generateId } from '../auth.js';
import { getGatewayDb } from '../db/connection.js';
import type {
  OrchestrationRun,
  OrchestrationRunStatus,
  OrchestratorGraph,
  OrchestratorMember,
} from './types.js';

function now(): string {
  return new Date().toISOString();
}

export function saveOrchestratorGraph(
  orchestratorWorkspaceId: string,
  graph: OrchestratorGraph,
): void {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_orchestrator_graphs (orchestrator_workspace_id, graph_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(orchestrator_workspace_id) DO UPDATE SET
         graph_json = excluded.graph_json,
         updated_at = excluded.updated_at`,
    )
    .run(orchestratorWorkspaceId, JSON.stringify(graph), ts);
}

export function getOrchestratorGraph(orchestratorWorkspaceId: string): OrchestratorGraph | null {
  const row = getGatewayDb()
    .prepare(
      'SELECT graph_json FROM gateway_orchestrator_graphs WHERE orchestrator_workspace_id = ?',
    )
    .get(orchestratorWorkspaceId) as { graph_json: string } | undefined;
  if (!row?.graph_json) return null;
  try {
    return JSON.parse(row.graph_json) as OrchestratorGraph;
  } catch {
    return null;
  }
}

export function replaceOrchestratorMembers(
  orchestratorWorkspaceId: string,
  members: Array<{
    member_workspace_id: string;
    member_agent_group_id: string;
    local_name: string;
    role?: string | null;
  }>,
): void {
  const db = getGatewayDb();
  const ts = now();
  db.transaction(() => {
    db.prepare('DELETE FROM gateway_orchestrator_members WHERE orchestrator_workspace_id = ?').run(
      orchestratorWorkspaceId,
    );
    const insert = db.prepare(
      `INSERT INTO gateway_orchestrator_members (
         orchestrator_workspace_id, member_workspace_id, member_agent_group_id,
         local_name, role, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const m of members) {
      insert.run(
        orchestratorWorkspaceId,
        m.member_workspace_id,
        m.member_agent_group_id,
        m.local_name.trim().toLowerCase(),
        m.role ?? null,
        ts,
      );
    }
  })();
}

export function listOrchestratorMembers(orchestratorWorkspaceId: string): OrchestratorMember[] {
  return getGatewayDb()
    .prepare(
      `SELECT orchestrator_workspace_id, member_workspace_id, member_agent_group_id,
              local_name, role, created_at
       FROM gateway_orchestrator_members
       WHERE orchestrator_workspace_id = ?
       ORDER BY local_name`,
    )
    .all(orchestratorWorkspaceId) as OrchestratorMember[];
}

export function deleteOrchestrationForWorkspace(workspaceId: string): void {
  const db = getGatewayDb();
  db.transaction(() => {
    db.prepare('DELETE FROM gateway_orchestrator_members WHERE orchestrator_workspace_id = ?').run(
      workspaceId,
    );
    db.prepare('DELETE FROM gateway_orchestrator_members WHERE member_workspace_id = ?').run(
      workspaceId,
    );
    db.prepare('DELETE FROM gateway_orchestrator_graphs WHERE orchestrator_workspace_id = ?').run(
      workspaceId,
    );
    const runs = db
      .prepare('SELECT id FROM gateway_orchestration_runs WHERE orchestrator_workspace_id = ?')
      .all(workspaceId) as Array<{ id: string }>;
    const delEvents = db.prepare('DELETE FROM gateway_orchestration_events WHERE run_id = ?');
    for (const r of runs) delEvents.run(r.id);
    db.prepare('DELETE FROM gateway_orchestration_runs WHERE orchestrator_workspace_id = ?').run(
      workspaceId,
    );
  })();
}

function rowToRun(row: Record<string, unknown>): OrchestrationRun {
  return {
    id: row.id as string,
    orchestrator_workspace_id: row.orchestrator_workspace_id as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    status: row.status as OrchestrationRunStatus,
    current_node: (row.current_node as string | null) ?? null,
    state_json: (row.state_json as string) || '{}',
    goal: (row.goal as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createOrchestrationRun(input: {
  orchestrator_workspace_id: string;
  conversation_id?: string | null;
  goal?: string | null;
  current_node?: string | null;
  state?: Record<string, unknown>;
}): OrchestrationRun {
  const id = generateId('orun');
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_orchestration_runs (
         id, orchestrator_workspace_id, conversation_id, status, current_node,
         state_json, goal, created_at, updated_at
       ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.orchestrator_workspace_id,
      input.conversation_id ?? null,
      input.current_node ?? null,
      JSON.stringify(input.state ?? {}),
      input.goal ?? null,
      ts,
      ts,
    );
  return getOrchestrationRun(id)!;
}

export function getOrchestrationRun(id: string): OrchestrationRun | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_orchestration_runs WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function getActiveOrchestrationRun(
  orchestratorWorkspaceId: string,
  conversationId?: string | null,
  options?: { fallbackToAny?: boolean },
): OrchestrationRun | null {
  if (conversationId) {
    const row = getGatewayDb()
      .prepare(
        `SELECT * FROM gateway_orchestration_runs
         WHERE orchestrator_workspace_id = ? AND conversation_id = ?
           AND status IN ('running', 'waiting')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(orchestratorWorkspaceId, conversationId) as Record<string, unknown> | undefined;
    if (row) return rowToRun(row);
    if (options?.fallbackToAny === false) return null;
  }
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_orchestration_runs
       WHERE orchestrator_workspace_id = ? AND status IN ('running', 'waiting')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(orchestratorWorkspaceId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function updateOrchestrationRun(
  id: string,
  patch: {
    status?: OrchestrationRunStatus;
    current_node?: string | null;
    state?: Record<string, unknown>;
    goal?: string | null;
  },
): OrchestrationRun | null {
  const existing = getOrchestrationRun(id);
  if (!existing) return null;
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE gateway_orchestration_runs SET
         status = COALESCE(?, status),
         current_node = CASE WHEN ? THEN ? ELSE current_node END,
         state_json = COALESCE(?, state_json),
         goal = COALESCE(?, goal),
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status ?? null,
      patch.current_node !== undefined ? 1 : 0,
      patch.current_node ?? null,
      patch.state ? JSON.stringify(patch.state) : null,
      patch.goal ?? null,
      ts,
      id,
    );
  return getOrchestrationRun(id);
}

export function appendOrchestrationEvent(
  runId: string,
  eventType: string,
  payload?: Record<string, unknown>,
): void {
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_orchestration_events (id, run_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      generateId('oevt'),
      runId,
      eventType,
      payload ? JSON.stringify(payload) : null,
      now(),
    );
}

export interface OrchestrationEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export function listOrchestrationEvents(runId: string, limit = 100): OrchestrationEvent[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT id, run_id, event_type, payload_json, created_at
       FROM gateway_orchestration_events
       WHERE run_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(runId, limit) as Array<{
    id: string;
    run_id: string;
    event_type: string;
    payload_json: string | null;
    created_at: string;
  }>;

  return rows.map((r) => {
    let payload: Record<string, unknown> | null = null;
    if (r.payload_json) {
      try {
        payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        payload = { raw: r.payload_json };
      }
    }
    return {
      id: r.id,
      run_id: r.run_id,
      event_type: r.event_type,
      payload,
      created_at: r.created_at,
    };
  });
}

export function listOrchestrationRuns(
  orchestratorWorkspaceId: string,
  options: { limit?: number; activeOnly?: boolean } = {},
): OrchestrationRun[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  if (options.activeOnly) {
    return (
      getGatewayDb()
        .prepare(
          `SELECT * FROM gateway_orchestration_runs
           WHERE orchestrator_workspace_id = ? AND status IN ('running', 'waiting')
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(orchestratorWorkspaceId, limit) as Record<string, unknown>[]
    ).map(rowToRun);
  }
  return (
    getGatewayDb()
      .prepare(
        `SELECT * FROM gateway_orchestration_runs
         WHERE orchestrator_workspace_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(orchestratorWorkspaceId, limit) as Record<string, unknown>[]
  ).map(rowToRun);
}

export function parseRunState(run: OrchestrationRun): Record<string, unknown> {
  try {
    return JSON.parse(run.state_json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Studio overview for one orchestrator workspace. */
export function getOrchestrationOverview(orchestratorWorkspaceId: string): {
  members: OrchestratorMember[];
  graph: OrchestratorGraph | null;
  active_run: (OrchestrationRun & { state: Record<string, unknown>; events: OrchestrationEvent[] }) | null;
  recent_runs: Array<OrchestrationRun & { state: Record<string, unknown> }>;
} {
  const members = listOrchestratorMembers(orchestratorWorkspaceId);
  const graph = getOrchestratorGraph(orchestratorWorkspaceId);
  const active = getActiveOrchestrationRun(orchestratorWorkspaceId);
  const recent = listOrchestrationRuns(orchestratorWorkspaceId, { limit: 10 });

  return {
    members,
    graph,
    active_run: active
      ? {
          ...active,
          state: parseRunState(active),
          events: listOrchestrationEvents(active.id),
        }
      : null,
    recent_runs: recent.map((r) => ({ ...r, state: parseRunState(r) })),
  };
}

/** Lightweight active status for agent list badges. */
export function getActiveRunSummary(orchestratorWorkspaceId: string): {
  status: string;
  current_node: string | null;
  updated_at: string;
} | null {
  const run = getActiveOrchestrationRun(orchestratorWorkspaceId);
  if (!run) return null;
  return {
    status: run.status,
    current_node: run.current_node,
    updated_at: run.updated_at,
  };
}

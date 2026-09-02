import { getGatewayDb } from '../db/connection.js';
import type {
  BuildJob,
  BuildJobDetail,
  BuildJobKind,
  BuildJobStatus,
  BuildMessage,
  BuildMessageRole,
  BuildRun,
  BuildRunKind,
  BuildRunStatus,
  MessageDirection,
} from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function rowToJob(row: Record<string, unknown>): BuildJob {
  const jobKind = row.job_kind === 'edit' ? 'edit' : 'create';
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    status: row.status as BuildJobStatus,
    job_kind: jobKind,
    title: (row.title as string | null) ?? null,
    builder_workspace_id: row.builder_workspace_id as string,
    builder_agent_group_id: row.builder_agent_group_id as string,
    builder_session_id: row.builder_session_id as string,
    target_workspace_id: (row.target_workspace_id as string | null) ?? null,
    preview_workspace_id: (row.preview_workspace_id as string | null) ?? null,
    preview_agent_group_id: (row.preview_agent_group_id as string | null) ?? null,
    preview_session_id: (row.preview_session_id as string | null) ?? null,
    result_workspace_id: (row.result_workspace_id as string | null) ?? null,
    result_agent_group_id: (row.result_agent_group_id as string | null) ?? null,
    delivery_channel_type: (row.delivery_channel_type as string | null) ?? null,
    delivery_platform_id: (row.delivery_platform_id as string | null) ?? null,
    delivery_thread_id: (row.delivery_thread_id as string | null) ?? null,
    pending_mcp_url: (row.pending_mcp_url as string | null) ?? null,
    pending_connection_id: (row.pending_connection_id as string | null) ?? null,
    pending_mcp_server_name: (row.pending_mcp_server_name as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToMessage(row: Record<string, unknown>): BuildMessage {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(row.content_json as string) as Record<string, unknown>;
  } catch {
    content = { text: String(row.content_json) };
  }
  return {
    id: row.id as string,
    job_id: row.job_id as string,
    direction: row.direction as MessageDirection,
    role: row.role as BuildMessageRole,
    content,
    run_id: (row.run_id as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

function rowToRun(row: Record<string, unknown>): BuildRun {
  return {
    id: row.id as string,
    job_id: row.job_id as string,
    kind: row.kind === 'test' ? 'test' : 'builder',
    status: row.status as BuildRunStatus,
    worker_status: (row.worker_status as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createBuildJob(input: {
  id: string;
  user_id: string;
  title?: string;
  job_kind?: BuildJobKind;
  builder_workspace_id: string;
  builder_agent_group_id: string;
  builder_session_id: string;
  target_workspace_id?: string | null;
  preview_workspace_id?: string | null;
  preview_agent_group_id?: string | null;
  preview_session_id?: string | null;
  delivery_channel_type?: string | null;
  delivery_platform_id?: string | null;
  delivery_thread_id?: string | null;
}): BuildJob {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO build_jobs (
         id, user_id, status, job_kind, title,
         builder_workspace_id, builder_agent_group_id, builder_session_id,
         target_workspace_id, preview_workspace_id, preview_agent_group_id, preview_session_id,
         delivery_channel_type, delivery_platform_id, delivery_thread_id,
         created_at, updated_at
       ) VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.user_id,
      input.job_kind ?? 'create',
      input.title ?? null,
      input.builder_workspace_id,
      input.builder_agent_group_id,
      input.builder_session_id,
      input.target_workspace_id ?? null,
      input.preview_workspace_id ?? null,
      input.preview_agent_group_id ?? null,
      input.preview_session_id ?? null,
      input.delivery_channel_type ?? null,
      input.delivery_platform_id ?? null,
      input.delivery_thread_id ?? null,
      ts,
      ts,
    );
  return getBuildJob(input.id)!;
}

export function getBuildJob(jobId: string): BuildJob | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM build_jobs WHERE id = ?')
    .get(jobId) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function getBuildJobForUser(jobId: string, userId: string): BuildJob | null {
  const job = getBuildJob(jobId);
  if (!job || job.user_id !== userId) return null;
  return job;
}

export function getActiveBuildJobForUser(userId: string): BuildJob | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM build_jobs
       WHERE user_id = ? AND status IN ('in_progress', 'waiting_for_user')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function listBuildJobsForUser(userId: string, limit = 20): BuildJob[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM build_jobs WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function updateBuildJobStatus(
  jobId: string,
  status: BuildJobStatus,
  patch?: {
    error?: string | null;
    result_workspace_id?: string | null;
    result_agent_group_id?: string | null;
    title?: string | null;
    preview_session_id?: string | null;
  },
): BuildJob {
  const current = getBuildJob(jobId);
  if (!current) throw new Error(`Build job not found: ${jobId}`);

  const ts = now();
  const error =
    status === 'completed' ? null : patch?.error !== undefined ? patch.error : current.error;
  const resultWorkspaceId =
    patch?.result_workspace_id !== undefined
      ? patch.result_workspace_id
      : current.result_workspace_id;
  const resultAgentGroupId =
    patch?.result_agent_group_id !== undefined
      ? patch.result_agent_group_id
      : current.result_agent_group_id;
  const title = patch?.title !== undefined ? patch.title : current.title;
  const previewSessionId =
    patch?.preview_session_id !== undefined ? patch.preview_session_id : current.preview_session_id;

  getGatewayDb()
    .prepare(
      `UPDATE build_jobs SET
         status = ?,
         error = ?,
         result_workspace_id = ?,
         result_agent_group_id = ?,
         title = ?,
         preview_session_id = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      error,
      resultWorkspaceId,
      resultAgentGroupId,
      title,
      previewSessionId,
      ts,
      jobId,
    );

  return getBuildJob(jobId)!;
}

export function setBuildJobPendingMcp(
  jobId: string,
  input: {
    mcpUrl?: string | null;
    connectionId?: string | null;
    mcpServerName?: string | null;
  },
): BuildJob {
  const current = getBuildJob(jobId);
  if (!current) throw new Error(`Build job not found: ${jobId}`);
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE build_jobs SET
         pending_mcp_url = ?,
         pending_connection_id = ?,
         pending_mcp_server_name = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.mcpUrl !== undefined ? input.mcpUrl : current.pending_mcp_url,
      input.connectionId !== undefined ? input.connectionId : current.pending_connection_id,
      input.mcpServerName !== undefined ? input.mcpServerName : current.pending_mcp_server_name,
      ts,
      jobId,
    );
  return getBuildJob(jobId)!;
}

export function insertBuildMessage(input: {
  id: string;
  job_id: string;
  direction: MessageDirection;
  role: BuildMessageRole;
  content: Record<string, unknown>;
  run_id?: string | null;
}): BuildMessage {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO build_messages (id, job_id, direction, role, content_json, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.job_id,
      input.direction,
      input.role,
      JSON.stringify(input.content),
      input.run_id ?? null,
      ts,
    );
  getGatewayDb()
    .prepare('UPDATE build_jobs SET updated_at = ? WHERE id = ?')
    .run(ts, input.job_id);
  return listBuildMessages(input.job_id).find((m) => m.id === input.id)!;
}

export function listBuildMessages(jobId: string): BuildMessage[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM build_messages WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function createBuildRun(input: { id: string; job_id: string; kind?: BuildRunKind }): BuildRun {
  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO build_runs (id, job_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'accepted', ?, ?)`,
    )
    .run(input.id, input.job_id, input.kind ?? 'builder', ts, ts);
  return getBuildRun(input.id)!;
}

export function getActiveRunForJob(jobId: string, kind?: BuildRunKind): BuildRun | null {
  const row = kind
    ? (getGatewayDb()
        .prepare(
          `SELECT * FROM build_runs
           WHERE job_id = ? AND kind = ? AND status IN ('accepted', 'running')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(jobId, kind) as Record<string, unknown> | undefined)
    : (getGatewayDb()
        .prepare(
          `SELECT * FROM build_runs
           WHERE job_id = ? AND status IN ('accepted', 'running')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(jobId) as Record<string, unknown> | undefined);
  return row ? rowToRun(row) : null;
}

export function getBuildRun(runId: string): BuildRun | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM build_runs WHERE id = ?')
    .get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function updateBuildRun(
  runId: string,
  status: BuildRunStatus,
  patch?: { worker_status?: string | null; error?: string | null },
): BuildRun {
  const current = getBuildRun(runId);
  if (!current) throw new Error(`Build run not found: ${runId}`);
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE build_runs SET
         status = ?,
         worker_status = ?,
         error = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      patch?.worker_status !== undefined ? patch.worker_status : current.worker_status,
      patch?.error !== undefined ? patch.error : current.error,
      ts,
      runId,
    );
  return getBuildRun(runId)!;
}

export function listBuildRuns(jobId: string): BuildRun[] {
  const rows = getGatewayDb()
    .prepare('SELECT * FROM build_runs WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

export function getBuildJobDetail(jobId: string): BuildJobDetail | null {
  const job = getBuildJob(jobId);
  if (!job) return null;
  return {
    ...job,
    messages: listBuildMessages(jobId),
    runs: listBuildRuns(jobId),
  };
}

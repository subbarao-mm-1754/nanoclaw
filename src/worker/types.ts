import type { ContainerConfigSnapshot } from '../container-config.js';

export interface WorkerAgentFile {
  path: string;
  /** UTF-8 text or raw bytes (multipart attachments). */
  content: string | Buffer;
}

export interface WorkerDelivery {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  /** Local destination name for agent `<message to="...">` (default: `client`). */
  name?: string;
  display_name?: string;
}

export interface WorkerPrepareWorkspaceRequest {
  workspace_id: string;
  agent: {
    /** Central agent group id — written to container.json and used for session DB paths. */
    agent_group_id: string;
    name: string;
    folder?: string;
    container_config: ContainerConfigSnapshot;
    cli_scope?: string;
    /** Agent files stored under the workspace agent dir at the given relative paths. */
    files: WorkerAgentFile[];
  };
  options?: {
    /** When true, replace an existing workspace with the same workspace_id. Default false. */
    replace?: boolean;
  };
}

export interface WorkerProcessMessageRequest {
  job_id: string;
  /** Gateway build job id (full agent build). Echoed in async callbacks. */
  build_job_id?: string;
  workspace_id: string;
  session: {
    id: string;
    agent_group_id: string;
  };
  delivery: WorkerDelivery;
  inbound: {
    id: string;
    kind: string;
    timestamp: string;
    content: Record<string, unknown>;
    sender?: {
      id: string;
      display_name?: string;
    };
  };
  options?: {
    timeout_ms?: number;
    trigger?: 0 | 1;
    /** When false, prepare session only (no container spawn). Default true. */
    run_container?: boolean;
    /** When true, respond 202 and POST result to callback_url. */
    async?: boolean;
    callback_url?: string;
  };
}

/** Persisted alongside the materialized workspace on prepare. */
export interface WorkerWorkspaceManifest {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  folder: string;
  container_config: ContainerConfigSnapshot;
  cli_scope: string;
  created_at: string;
  updated_at: string;
}

export type WorkerJobStatus = 'prepared' | 'completed' | 'failed' | 'timeout';

export interface WorkerCollectedOutbound {
  id: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  content: Record<string, unknown>;
  files?: Array<{ filename: string; data_base64: string }>;
}

export interface WorkerMemoryPatch {
  files?: Array<{ path: string; content: string; deleted?: boolean }>;
}

export interface WorkerWorkspacePaths {
  root: string;
  group_dir: string;
  claude_shared_dir: string;
}

export interface WorkerPrepareWorkspaceResponse {
  workspace_id: string;
  status: 'prepared';
  workspace: WorkerWorkspacePaths;
  files_written: string[];
}

export interface WorkerProcessMessageResponse {
  job_id: string;
  build_job_id?: string;
  status: WorkerJobStatus;
  workspace_id: string;
  session: {
    id: string;
    agent_group_id: string;
  };
  workspace: WorkerWorkspacePaths;
  session_paths: {
    inbound_db: string;
    outbound_db: string;
  };
  inbound_message_id: string;
  outbound?: WorkerCollectedOutbound[];
  memory_patch?: WorkerMemoryPatch;
  detail?: string;
  error?: string;
}

export interface WorkerDestroyWorkspaceRequest {
  workspace_id: string;
  session_id?: string;
}

export interface WorkerDestroyWorkspaceResponse {
  workspace_id: string;
  status: 'destroyed';
  container_killed: boolean;
}

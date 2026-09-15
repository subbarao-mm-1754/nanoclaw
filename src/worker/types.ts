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
    /**
     * When true and the workspace already exists, rewrite files/config in place
     * without deleting the workspace root. Safe while a container still mounts
     * `/workspace/agent`. Prefer this over `replace` for routine refreshes.
     */
    refresh?: boolean;
    /**
     * Create if missing; refresh in place if content hash changed; no-op if unchanged.
     * Prefer this for the hot path (inbound messages) — one round-trip, no
     * create→already-exists→refresh dance.
     */
    ensure?: boolean;
  };
}

export interface WorkerProcessMessageRequest {
  job_id: string;
  /** Gateway build job id (full agent build). Echoed in async callbacks. */
  build_job_id?: string;
  workspace_id: string;
  /** Gateway conversation id — used when pushing outbound via continuous collector. */
  conversation_id?: string;
  session: {
    id: string;
    agent_group_id: string;
  };
  delivery: WorkerDelivery;
  /** Extra destinations (orchestrator specialists / parent link). */
  extra_destinations?: Array<{
    name: string;
    display_name?: string | null;
    type: 'channel' | 'agent';
    channel_type?: string | null;
    platform_id?: string | null;
    agent_group_id?: string | null;
  }>;
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
    /**
     * When true, block until a matching chat outbound appears (or timeout).
     * Used by tests / legacy one-shot collection. Prefer wait_for_turn for builds.
     */
    wait_for_outbound?: boolean;
    /**
     * When true (default for async/builder), stream outbound via the continuous
     * collector and block until processing_ack completes for the inbound message
     * (or timeout / container stop). Then POST run-result with memory_patch.
     */
    wait_for_turn?: boolean;
  };
}

/** Worker → Gateway push when the continuous collector drains chat outbound. */
export interface WorkerOutboundCallbackPayload {
  workspace_id: string;
  session_id: string;
  agent_group_id: string;
  conversation_id?: string;
  /** Worker / build run id (process-message job_id). */
  job_id?: string;
  /** When set, gateway routes delivery through the builder/edit channel path. */
  build_job_id?: string;
  outbound: WorkerCollectedOutbound[];
  memory_patch?: WorkerMemoryPatch;
}

/** Persisted alongside the materialized workspace on prepare. */
export interface WorkerWorkspaceManifest {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  folder: string;
  container_config: ContainerConfigSnapshot;
  cli_scope: string;
  /** SHA-256 of prepare payload (agent meta + files). Used to skip no-op refreshes. */
  content_hash?: string;
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
  /** `unchanged` when ensure/refresh found matching content_hash — no disk rewrite. */
  status: 'prepared' | 'unchanged';
  workspace: WorkerWorkspacePaths;
  files_written: string[];
  content_hash: string;
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

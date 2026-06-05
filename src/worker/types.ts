import type { ContainerConfigSnapshot } from '../container-config.js';

export interface WorkerJobRequest {
  job_id: string;
  session: {
    id: string;
    agent_group_id: string;
  };
  delivery: {
    channel_type: string;
    platform_id: string;
    thread_id: string | null;
  };
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
  agent_snapshot: {
    name: string;
    folder?: string;
    container_config: ContainerConfigSnapshot;
    instructions?: string;
    cli_scope?: string;
    files?: Array<{ path: string; content: string }>;
  };
  options?: {
    timeout_ms?: number;
    trigger?: 0 | 1;
    /** When false, prepare session only (no container spawn). Default true. */
    run_container?: boolean;
  };
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
  instructions?: string;
  files?: Array<{ path: string; content: string; deleted?: boolean }>;
}

export interface WorkerJobResponse {
  job_id: string;
  status: WorkerJobStatus;
  session: {
    id: string;
    agent_group_id: string;
  };
  workspace: {
    root: string;
    group_dir: string;
    claude_shared_dir: string;
  };
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

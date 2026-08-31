import type { ContainerConfigSnapshot } from '../container-config.js';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'pending' | 'processing' | 'delivered' | 'failed';
export type ChannelConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface ChannelConnection {
  channel_type: string;
  display_name: string | null;
  status: ChannelConnectionStatus;
  connected_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface GatewayUser {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface GatewaySession {
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface GatewayAgentFile {
  path: string;
  content: string;
}

export interface GatewayWorkspace {
  workspace_id: string;
  agent_group_id: string;
  name: string;
  is_default: boolean;
  owner_user_id: string | null;
  folder: string | null;
  cli_scope: string;
  container_config: ContainerConfigSnapshot | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayAgent extends GatewayWorkspace {
  files: GatewayAgentFile[];
}

export interface Conversation {
  id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  workspace_id: string;
  session_id: string;
  agent_group_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerMessage {
  id: string;
  direction: MessageDirection;
  status: MessageStatus;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  conversation_id: string | null;
  kind: string;
  content_json: string;
  sender_id: string | null;
  sender_display_name: string | null;
  files_json: string | null;
  worker_job_id: string | null;
  worker_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboundEnqueueInput {
  id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  kind: string;
  content: unknown;
  sender_id?: string;
  sender_display_name?: string;
  timestamp: string;
}

/** Full agent-build unit of work (one job per build; never reused). */
export type BuildJobStatus = 'in_progress' | 'waiting_for_user' | 'completed' | 'failed';

export type BuildRunStatus = 'accepted' | 'running' | 'completed' | 'failed';

export type BuildMessageRole = 'user' | 'builder' | 'system';

export interface BuildJob {
  id: string;
  user_id: string;
  status: BuildJobStatus;
  title: string | null;
  builder_workspace_id: string;
  builder_agent_group_id: string;
  builder_session_id: string;
  result_workspace_id: string | null;
  result_agent_group_id: string | null;
  /** Where builder replies are delivered (e.g. zoho-cliq chat). */
  delivery_channel_type: string | null;
  delivery_platform_id: string | null;
  delivery_thread_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildMessage {
  id: string;
  job_id: string;
  direction: MessageDirection;
  role: BuildMessageRole;
  content: Record<string, unknown>;
  run_id: string | null;
  created_at: string;
}

export interface BuildRun {
  id: string;
  job_id: string;
  status: BuildRunStatus;
  worker_status: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildJobDetail extends BuildJob {
  messages: BuildMessage[];
  runs: BuildRun[];
}

/** Parsed from builder outbound (structured JSON fence / marker). */
export type ParsedBuildStatus = 'needs_input' | 'completed' | 'failed' | 'progress';

export interface ParsedBuildResult {
  status: ParsedBuildStatus;
  agent_name?: string;
  files?: GatewayAgentFile[];
  error?: string;
}

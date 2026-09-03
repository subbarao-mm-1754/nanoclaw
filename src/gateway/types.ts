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
  is_admin: boolean;
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

/** Full agent-build unit of work (one job per build or edit; never reused). */
export type BuildJobStatus = 'in_progress' | 'waiting_for_user' | 'completed' | 'failed';

export type BuildJobKind = 'create' | 'edit';

export type BuildRunStatus = 'accepted' | 'running' | 'completed' | 'failed';

export type BuildRunKind = 'builder' | 'test';

export type BuildMessageRole = 'user' | 'builder' | 'system';

export interface BuildJob {
  id: string;
  user_id: string;
  status: BuildJobStatus;
  job_kind: BuildJobKind;
  title: string | null;
  builder_workspace_id: string;
  builder_agent_group_id: string;
  builder_session_id: string;
  /** Existing user agent being edited (`edit` jobs only). */
  target_workspace_id: string | null;
  /** Draft workspace used for `/test` while editing — not bound to Cliq. */
  preview_workspace_id: string | null;
  preview_agent_group_id: string | null;
  preview_session_id: string | null;
  result_workspace_id: string | null;
  result_agent_group_id: string | null;
  /** Where builder replies are delivered (e.g. zoho-cliq chat). */
  delivery_channel_type: string | null;
  delivery_platform_id: string | null;
  delivery_thread_id: string | null;
  /** Remote MCP URL pasted during build — attached after OAuth + agent create. */
  pending_mcp_url: string | null;
  pending_connection_id: string | null;
  pending_mcp_server_name: string | null;
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
  kind: BuildRunKind;
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

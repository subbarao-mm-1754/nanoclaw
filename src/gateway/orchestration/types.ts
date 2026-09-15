import type { GatewayAgentFile } from '../types.js';

export type AgentKind = 'agent' | 'orchestrator';

export type OrchestrationRunStatus = 'running' | 'waiting' | 'completed' | 'failed';

/** Graph node: deterministic step or LLM decision. */
export interface OrchestratorGraphNode {
  id: string;
  /** Destination local_name of a specialist, or "orchestrator" for decision nodes. */
  agent?: string;
  type?: 'task' | 'decision' | 'join';
  description?: string;
}

export interface OrchestratorGraphEdge {
  from: string;
  to: string;
  /** Optional condition label (e.g. "retry", "done", "fail"). */
  when?: string;
}

export interface OrchestratorGraphLoop {
  from: string;
  to: string;
  max_iterations: number;
  when?: string;
}

export interface OrchestratorGraph {
  entry?: string;
  nodes: OrchestratorGraphNode[];
  edges?: OrchestratorGraphEdge[];
  loops?: OrchestratorGraphLoop[];
}

export type SpecialistBuildAction = 'create' | 'reuse';

/** Specialist declared in a completed build fence. */
export interface ParsedSpecialistSpec {
  /** Destination name the orchestrator uses in send_message(to=…). */
  name: string;
  action: SpecialistBuildAction;
  /** Display / agent name when creating. */
  agent_name?: string;
  role?: string;
  /** Reuse an existing user agent by workspace id. */
  workspace_id?: string;
  /** Reuse by exact agent name (resolved at register time). */
  reuse_name?: string;
  files?: GatewayAgentFile[];
}

export interface OrchestratorMember {
  orchestrator_workspace_id: string;
  member_workspace_id: string;
  member_agent_group_id: string;
  local_name: string;
  role: string | null;
  created_at: string;
}

export interface OrchestrationRun {
  id: string;
  orchestrator_workspace_id: string;
  conversation_id: string | null;
  status: OrchestrationRunStatus;
  current_node: string | null;
  state_json: string;
  goal: string | null;
  created_at: string;
  updated_at: string;
}

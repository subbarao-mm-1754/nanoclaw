/**
 * Graph state for multi-agent orchestration runs.
 * One thread per orchestration run id (multi-user / multi-conversation safe).
 */
import type { SpecialistReplyStatus } from '../specialist-protocol.js';
import type { StateChannels } from './engine.js';

export interface SpecialistResult {
  text: string;
  from_agent: string;
  /** Full output is kept in a run-scoped gateway artifact, never in task packets. */
  artifact_id?: string;
  artifact_summary?: string;
  artifact_byte_size?: number;
  message_id?: string;
  at: string;
  /** @deprecated Prefer status === 'partial' */
  partial?: boolean;
  /** Protocol status that produced this result (terminal only when stored on the node). */
  status?: SpecialistReplyStatus;
}

/** Orchestrator flow decision — may pick among allowed branches only. */
export interface OrchestratorDecision {
  /** Next node id or edge `when` label from the registered graph. */
  branch: string;
  /** Optional task packet for the next specialist. */
  task_packet?: string;
  /** Soft skip flags (runtime deviation; does not mutate stored graph). */
  skip_nodes?: string[];
  /** Mark the run complete after this decision. */
  complete?: boolean;
  note?: string;
}

export type WaitKind = 'user' | 'decision' | 'specialist';

export interface PendingWait {
  kind: WaitKind;
  node_id: string;
  agent?: string;
  task_packet?: string;
  allowed_branches?: string[];
  since: string;
  nudge_count: number;
}

export type GraphRunStatus = 'running' | 'waiting' | 'completed' | 'failed';

export interface OrchestrationGraphState {
  goal: string;
  last_user_message: string;
  user_messages: string[];
  current_node: string;
  /** Last chosen branch / when label (orchestrator decision). */
  branch: string | null;
  decision: OrchestratorDecision | null;
  results: Record<string, SpecialistResult>;
  loop_counts: Record<string, number>;
  skip_nodes: string[];
  pending_wait: PendingWait | null;
  status: GraphRunStatus;
  error: string | null;
}

export const OrchestrationStateChannels: StateChannels<OrchestrationGraphState> = {
  goal: { reducer: (_a, b) => b, default: () => '' },
  last_user_message: { reducer: (_a, b) => b, default: () => '' },
  user_messages: {
    reducer: (a, b) => (Array.isArray(b) ? [...a, ...b] : a),
    default: () => [],
  },
  current_node: { reducer: (_a, b) => b, default: () => '' },
  branch: { reducer: (_a, b) => b, default: () => null },
  decision: { reducer: (_a, b) => b, default: () => null },
  results: { reducer: (a, b) => ({ ...a, ...(b ?? {}) }), default: () => ({}) },
  loop_counts: { reducer: (a, b) => ({ ...a, ...(b ?? {}) }), default: () => ({}) },
  skip_nodes: { reducer: (a, b) => (Array.isArray(b) ? b : a), default: () => [] },
  pending_wait: { reducer: (_a, b) => b, default: () => null },
  status: { reducer: (_a, b) => b, default: () => 'running' },
  error: { reducer: (_a, b) => b, default: () => null },
};

export type InterruptPayload =
  | {
      kind: 'await_user' | 'await_decision';
      node_id: string;
      allowed_branches: string[];
      goal: string;
      current_node: string;
      results_summary: Record<string, string>;
    }
  | {
      kind: 'await_specialist';
      node_id: string;
      agent: string;
      task_packet: string;
      goal: string;
      /** Node agent is the orchestrator itself (not an A2A member). */
      self?: boolean;
    };

export type ResumePayload =
  | { kind: 'user'; text: string }
  | {
      kind: 'decision';
      branch: string;
      task_packet?: string;
      skip_nodes?: string[];
      complete?: boolean;
      note?: string;
    }
  | {
      kind: 'specialist';
      text: string;
      from_agent: string;
      artifact_id?: string;
      artifact_summary?: string;
      artifact_byte_size?: number;
      message_id?: string;
      partial?: boolean;
      status?: SpecialistReplyStatus;
    }
  | {
      kind: 'timeout';
      action: 'nudge' | 'fail' | 'partial';
      partial_text?: string;
    };

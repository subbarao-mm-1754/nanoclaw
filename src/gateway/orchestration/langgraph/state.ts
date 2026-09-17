/**
 * LangGraph state for multi-agent orchestration runs.
 * One thread per orchestration run id (multi-user / multi-conversation safe).
 */
import { Annotation } from '@langchain/langgraph';

export interface SpecialistResult {
  text: string;
  from_agent: string;
  message_id?: string;
  at: string;
  partial?: boolean;
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

export const OrchestrationStateAnnotation = Annotation.Root({
  goal: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => '',
  }),
  last_user_message: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => '',
  }),
  user_messages: Annotation<string[]>({
    reducer: (a, b) => (Array.isArray(b) ? [...a, ...b] : a),
    default: () => [],
  }),
  current_node: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => '',
  }),
  /** Last chosen branch / when label (orchestrator decision). */
  branch: Annotation<string | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  decision: Annotation<OrchestratorDecision | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  results: Annotation<Record<string, SpecialistResult>>({
    reducer: (a, b) => ({ ...a, ...(b ?? {}) }),
    default: () => ({}),
  }),
  loop_counts: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...a, ...(b ?? {}) }),
    default: () => ({}),
  }),
  skip_nodes: Annotation<string[]>({
    reducer: (_a, b) => (Array.isArray(b) ? b : _a),
    default: () => [],
  }),
  pending_wait: Annotation<PendingWait | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  status: Annotation<GraphRunStatus>({
    reducer: (_a, b) => b,
    default: () => 'running',
  }),
  error: Annotation<string | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
});

export type OrchestrationGraphState = typeof OrchestrationStateAnnotation.State;

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
      message_id?: string;
      partial?: boolean;
    }
  | {
      kind: 'timeout';
      action: 'nudge' | 'fail' | 'partial';
      partial_text?: string;
    };

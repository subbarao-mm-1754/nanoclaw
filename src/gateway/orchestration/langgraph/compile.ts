/**
 * Compile a builder-stored OrchestratorGraph into a LangGraph StateGraph.
 *
 * The registered graph / loops / rules are fixed at compile time. The orchestrator
 * may only choose among allowed branches (edge `when` labels / successor node ids)
 * and set soft skip flags — it cannot mutate the graph structure.
 */
import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { OrchestratorGraph, OrchestratorGraphEdge, OrchestratorGraphLoop } from '../types.js';
import {
  OrchestrationStateAnnotation,
  type InterruptPayload,
  type OrchestrationGraphState,
  type OrchestratorDecision,
  type ResumePayload,
  type SpecialistResult,
} from './state.js';

export const HANDLE_USER_NODE = 'handle_user';

function loopKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function successors(
  graph: OrchestratorGraph,
  from: string,
): Array<{ to: string; when?: string; isLoop: boolean; maxIterations?: number }> {
  const out: Array<{ to: string; when?: string; isLoop: boolean; maxIterations?: number }> = [];
  for (const e of graph.edges ?? []) {
    if (e.from === from) out.push({ to: e.to, when: e.when, isLoop: false });
  }
  for (const l of graph.loops ?? []) {
    if (l.from === from) {
      out.push({
        to: l.to,
        when: l.when,
        isLoop: true,
        maxIterations: l.max_iterations,
      });
    }
  }
  return out;
}

function allowedBranches(graph: OrchestratorGraph, from: string): string[] {
  const succs = successors(graph, from);
  const labels = new Set<string>();
  for (const s of succs) {
    if (s.when) labels.add(s.when);
    labels.add(s.to);
    const agent = graph.nodes.find((n) => n.id === s.to)?.agent?.trim().toLowerCase();
    if (agent && agent !== 'orchestrator') labels.add(agent);
  }
  // Entry / all task agents are always choosable from handle_user on a fresh run.
  if (from === graph.entry || from === HANDLE_USER_NODE || !from) {
    for (const n of graph.nodes) {
      labels.add(n.id);
      const agent = n.agent?.trim().toLowerCase();
      if (agent && agent !== 'orchestrator') labels.add(agent);
    }
  }
  labels.add('complete');
  labels.add('status');
  return [...labels];
}

function resultsSummary(state: OrchestrationGraphState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.results ?? {})) {
    out[k] = (v.text || '').slice(0, 400);
  }
  return out;
}

function predecessors(graph: OrchestratorGraph, nodeId: string): string[] {
  const preds: string[] = [];
  for (const e of graph.edges ?? []) {
    if (e.to === nodeId) preds.push(e.from);
  }
  return preds;
}

function hasNodeResult(state: OrchestrationGraphState, nodeId: string): boolean {
  return Boolean(state.results?.[nodeId]);
}

/**
 * If `to` is a join (multiple inbound edges), require sibling predecessors to have
 * results first — otherwise return the first missing sibling node id.
 */
function resolveJoinOrNext(
  graph: OrchestratorGraph,
  to: string,
  from: string,
  state: OrchestrationGraphState,
): string {
  const preds = predecessors(graph, to);
  if (preds.length > 1) {
    const missing = preds.filter((p) => p !== from && !hasNodeResult(state, p));
    if (missing.length > 0) return missing[0]!;
  }
  return to;
}

function pickNext(
  graph: OrchestratorGraph,
  from: string,
  state: OrchestrationGraphState,
): string | typeof END {
  if (state.decision?.complete || state.branch === 'complete') return END;
  if (state.branch === 'status') return HANDLE_USER_NODE;

  // Sitting on a join target with unfinished siblings (e.g. assemble before images) —
  // finish the missing predecessor first instead of parking on handle_user.
  if (from && from !== HANDLE_USER_NODE) {
    const predsOfFrom = predecessors(graph, from);
    if (predsOfFrom.length > 1) {
      const missing = predsOfFrom.filter((p) => !hasNodeResult(state, p));
      if (missing.length > 0) return missing[0]!;
    }
  }

  const skip = new Set(state.skip_nodes ?? []);
  const succs = successors(graph, from).filter((s) => !skip.has(s.to));

  const branch = state.branch ?? state.decision?.branch ?? null;
  if (branch) {
    const byWhen = succs.find((s) => s.when === branch);
    if (byWhen) {
      if (byWhen.isLoop) {
        const key = loopKey(from, byWhen.to);
        const count = (state.loop_counts?.[key] ?? 0) + 1;
        const max = byWhen.maxIterations ?? 2;
        if (count > max) {
          // Loop exhausted — fall through to non-loop successors or END.
          const nonLoop = succs.filter((s) => !s.isLoop && !s.when);
          if (nonLoop.length === 1) {
            return resolveJoinOrNext(graph, nonLoop[0]!.to, from, state);
          }
          if (nonLoop.length === 0) return END;
          return HANDLE_USER_NODE;
        }
      }
      return resolveJoinOrNext(graph, byWhen.to, from, state);
    }
    const byTo = succs.find((s) => s.to === branch);
    if (byTo) {
      if (byTo.isLoop) {
        const key = loopKey(from, byTo.to);
        const count = (state.loop_counts?.[key] ?? 0) + 1;
        const max = byTo.maxIterations ?? 2;
        if (count > max) {
          const nonLoop = succs.filter((s) => !s.isLoop);
          if (nonLoop.length === 1) {
            return resolveJoinOrNext(graph, nonLoop[0]!.to, from, state);
          }
          return END;
        }
      }
      return resolveJoinOrNext(graph, byTo.to, from, state);
    }
  }

  const unconditional = succs.filter((s) => !s.when && !s.isLoop);
  if (unconditional.length === 1) {
    return resolveJoinOrNext(graph, unconditional[0]!.to, from, state);
  }
  if (unconditional.length > 1) {
    // Fan-out: auto-advance the first unfinished parallel branch instead of
    // parking forever on handle_user (TripPlanner research → images + logistics).
    const pending = unconditional.filter((s) => !hasNodeResult(state, s.to));
    if (pending.length > 0) return pending[0]!.to;
    // All parallel children done — prefer their shared join if any.
    const childTargets = new Set<string>();
    for (const s of unconditional) {
      for (const next of successors(graph, s.to)) {
        if (!next.when && !next.isLoop) childTargets.add(next.to);
      }
    }
    if (childTargets.size === 1) {
      return resolveJoinOrNext(graph, [...childTargets][0]!, from, state);
    }
    return HANDLE_USER_NODE;
  }
  if (unconditional.length === 0 && succs.length === 0) return END;
  // Ambiguous conditional edges — orchestrator must decide.
  return HANDLE_USER_NODE;
}

/** Exported for unit tests. */
export function resolveGraphNext(
  graph: OrchestratorGraph,
  from: string,
  state: Partial<OrchestrationGraphState>,
): string | typeof END {
  return pickNext(graph, from, {
    goal: '',
    last_user_message: '',
    user_messages: [],
    current_node: from,
    branch: null,
    decision: null,
    results: {},
    loop_counts: {},
    skip_nodes: [],
    pending_wait: null,
    status: 'running',
    error: null,
    ...state,
  } as OrchestrationGraphState);
}

function bumpLoopCounts(
  graph: OrchestratorGraph,
  from: string,
  to: string,
  state: OrchestrationGraphState,
): Record<string, number> | undefined {
  const loop = (graph.loops ?? []).find((l) => l.from === from && l.to === to);
  if (!loop) return undefined;
  const key = loopKey(from, to);
  return { [key]: (state.loop_counts?.[key] ?? 0) + 1 };
}

function isTaskNode(graph: OrchestratorGraph, nodeId: string): boolean {
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (!n) return false;
  if (n.type === 'decision' || n.type === 'join') return false;
  const agent = (n.agent || '').trim().toLowerCase();
  if (!agent || agent === 'orchestrator') return false;
  return true;
}

function nodeAgent(graph: OrchestratorGraph, nodeId: string): string | undefined {
  const n = graph.nodes.find((x) => x.id === nodeId);
  return n?.agent?.trim().toLowerCase() || undefined;
}

function buildTaskPacket(graph: OrchestratorGraph, nodeId: string, state: OrchestrationGraphState): string {
  if (state.decision?.task_packet?.trim()) return state.decision.task_packet.trim();
  const n = graph.nodes.find((x) => x.id === nodeId);
  const parts = [
    `Orchestration task for node "${nodeId}"` + (n?.agent ? ` (agent: ${n.agent})` : ''),
    state.goal ? `Goal: ${state.goal}` : '',
    n?.description ? `Description: ${n.description}` : '',
    state.last_user_message ? `Latest user request: ${state.last_user_message}` : '',
  ];
  const prior = Object.entries(state.results ?? {});
  if (prior.length) {
    parts.push('Prior specialist results:');
    for (const [id, r] of prior) {
      parts.push(`- ${id} (${r.from_agent}): ${r.text.slice(0, 800)}`);
    }
  }
  parts.push(
    'Reply to the orchestrator using the specialist reply protocol:',
    '- Mid-work: status "ack" or "progress" (does NOT finish this node).',
    '- Done: status "completed" with the full payload (or "blocked"/"failed"/"partial").',
    'Use send_message(..., orchestration_status) or <message to="orchestrator" status="…">.',
    'Do not send user-facing chat — only reply to the orchestrator.',
  );
  return parts.filter(Boolean).join('\n');
}

function applyDecisionResume(
  resume: Extract<ResumePayload, { kind: 'decision' }>,
): Partial<OrchestrationGraphState> {
  const decision: OrchestratorDecision = {
    branch: resume.branch,
    task_packet: resume.task_packet,
    skip_nodes: resume.skip_nodes,
    complete: resume.complete,
    note: resume.note,
  };
  return {
    decision,
    branch: resume.branch,
    skip_nodes: resume.skip_nodes ?? [],
    pending_wait: null,
    status: resume.complete ? 'completed' : 'running',
  };
}

/**
 * Build a compiled LangGraph app from stored orchestrator graph JSON.
 * Returns null when there is no executable graph (soft / free-form mode).
 */
export function compileOrchestratorLangGraph(graph: OrchestratorGraph | null | undefined) {
  if (!graph?.nodes?.length) return null;

  const entry = graph.entry?.trim() || graph.nodes[0]!.id;
  // Dynamic node ids from builder JSON — loosen StateGraph's literal node typing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = new StateGraph(OrchestrationStateAnnotation);

  // --- handle_user: orchestrator decision hub (user-facing) ---
  builder.addNode(HANDLE_USER_NODE, async (state: OrchestrationGraphState) => {
    const from =
      !state.current_node || state.current_node === HANDLE_USER_NODE
        ? entry
        : state.current_node;
    const allowed = allowedBranches(graph, from);

    // Fresh user text already present and no pending decision → still ask orchestrator
    // to choose a branch among allowed edges (graph is locked).
    const payload: InterruptPayload = {
      kind: state.last_user_message ? 'await_decision' : 'await_user',
      node_id: HANDLE_USER_NODE,
      allowed_branches: allowed,
      goal: state.goal,
      current_node: from,
      results_summary: resultsSummary(state),
    };

    const resume = interrupt(payload) as ResumePayload;

    if (resume.kind === 'user') {
      return {
        last_user_message: resume.text,
        user_messages: [resume.text],
        goal: state.goal || resume.text.slice(0, 2000),
        // Keep graph cursor — do not reset to entry on status/chit-chat.
        current_node: from,
        pending_wait: null,
        status: 'running' as const,
        branch: null,
        decision: null,
      };
    }

    if (resume.kind === 'decision') {
      return {
        ...applyDecisionResume(resume),
        current_node: from,
      };
    }

    if (resume.kind === 'timeout' && resume.action === 'fail') {
      return {
        status: 'failed' as const,
        error: 'Orchestrator decision timed out',
        pending_wait: null,
      };
    }

    // Specialist result injected while on handle_user — store and re-decide.
    if (resume.kind === 'specialist') {
      const result: SpecialistResult = {
        text: resume.text,
        from_agent: resume.from_agent,
        message_id: resume.message_id,
        at: new Date().toISOString(),
        partial: resume.partial || resume.status === 'partial',
        status: resume.status ?? (resume.partial ? 'partial' : 'completed'),
      };
      return {
        results: { [state.current_node || 'inbox']: result },
        pending_wait: null,
        status: 'running' as const,
        branch: null,
        decision: null,
      };
    }

    return { pending_wait: null };
  });

  // --- per registered node ---
  for (const node of graph.nodes) {
    const nodeId = node.id;
    if (nodeId === HANDLE_USER_NODE) continue; // reserved

    if (isTaskNode(graph, nodeId)) {
      const agent = nodeAgent(graph, nodeId)!;
      builder.addNode(nodeId, async (state: OrchestrationGraphState) => {
        if ((state.skip_nodes ?? []).includes(nodeId)) {
          return {
            current_node: nodeId,
            pending_wait: null,
            branch: null,
            decision: null,
          };
        }

        const taskPacket = buildTaskPacket(graph, nodeId, state);
        const payload: InterruptPayload = {
          kind: 'await_specialist',
          node_id: nodeId,
          agent,
          task_packet: taskPacket,
          goal: state.goal,
        };

        // Mark wait metadata before interrupt so runner can persist it.
        // (interrupt throws/suspends; return after resume)
        const resume = interrupt(payload) as ResumePayload;

        if (resume.kind === 'user') {
          // Mid-wait user message → park text and bounce to handle_user.
          return {
            last_user_message: resume.text,
            user_messages: [resume.text],
            current_node: nodeId,
            pending_wait: null,
            branch: 'status', // route helper: pickNext maps status → handle_user
            decision: null,
          };
        }

        if (resume.kind === 'decision') {
          // Orchestrator cancelled/redirected while waiting.
          return {
            ...applyDecisionResume(resume),
            current_node: nodeId,
          };
        }

        if (resume.kind === 'timeout' && resume.action === 'fail') {
          return {
            status: 'failed' as const,
            error: `Specialist "${agent}" timed out on node "${nodeId}"`,
            current_node: nodeId,
            pending_wait: null,
          };
        }

        if (resume.kind === 'timeout' && resume.action === 'partial') {
          const result: SpecialistResult = {
            text: resume.partial_text || '(partial — timed out)',
            from_agent: agent,
            at: new Date().toISOString(),
            partial: true,
          };
          return {
            results: { [nodeId]: result },
            current_node: nodeId,
            pending_wait: null,
            branch: null,
            decision: null,
            status: 'running' as const,
          };
        }

        if (resume.kind === 'specialist') {
          const result: SpecialistResult = {
            text: resume.text,
            from_agent: resume.from_agent || agent,
            message_id: resume.message_id,
            at: new Date().toISOString(),
            partial: resume.partial || resume.status === 'partial',
            status: resume.status ?? (resume.partial ? 'partial' : 'completed'),
          };
          return {
            results: { [nodeId]: result },
            current_node: nodeId,
            pending_wait: null,
            branch: null,
            decision: null,
            status: 'running' as const,
          };
        }

        // nudge timeouts are handled outside (re-interrupt); ignore here
        return { current_node: nodeId };
      });
    } else {
      // Decision / join / orchestrator-owned node → same interrupt as handle_user
      builder.addNode(nodeId, async (state: OrchestrationGraphState) => {
        const allowed = allowedBranches(graph, nodeId);
        const payload: InterruptPayload = {
          kind: 'await_decision',
          node_id: nodeId,
          allowed_branches: allowed,
          goal: state.goal,
          current_node: nodeId,
          results_summary: resultsSummary(state),
        };
        const resume = interrupt(payload) as ResumePayload;

        if (resume.kind === 'user') {
          return {
            last_user_message: resume.text,
            user_messages: [resume.text],
            current_node: nodeId,
            pending_wait: null,
            branch: null,
            decision: null,
          };
        }
        if (resume.kind === 'decision') {
          return {
            ...applyDecisionResume(resume),
            current_node: nodeId,
          };
        }
        if (resume.kind === 'timeout' && resume.action === 'fail') {
          return {
            status: 'failed' as const,
            error: `Decision node "${nodeId}" timed out`,
            pending_wait: null,
          };
        }
        return { current_node: nodeId };
      });
    }
  }

  builder.addEdge(START, HANDLE_USER_NODE);

  builder.addConditionalEdges(HANDLE_USER_NODE, (state: OrchestrationGraphState) => {
    if (state.status === 'failed' || state.status === 'completed' || state.decision?.complete) {
      return END;
    }
    // From handle_user, route as if from logical current (or entry).
    const from = state.current_node && state.current_node !== HANDLE_USER_NODE
      ? state.current_node
      : entry;
    // If we just decided, prefer routing from entry on first decision.
    const routeFromNode =
      state.decision && (state.current_node === HANDLE_USER_NODE || !state.results || !Object.keys(state.results).length)
        ? entry
        : from;

    // User chit-chat with no explicit branch: if the graph already has progress and
    // pickNext can advance (e.g. missing join sibling), auto-continue instead of
    // re-parking forever on await_decision.
    if (state.last_user_message && !state.decision && state.branch === null) {
      const hasProgress = Object.keys(state.results ?? {}).length > 0;
      if (hasProgress) {
        const auto = pickNext(graph, from, state);
        if (auto !== END && auto !== HANDLE_USER_NODE) return auto;
      }
      return HANDLE_USER_NODE;
    }

    // First decision with empty results: go to entry (or chosen branch node).
    if (state.decision?.branch) {
      const chosen = state.decision.branch;
      if (chosen === 'complete') return END;
      if (chosen === 'status') return HANDLE_USER_NODE;
      if (graph.nodes.some((n) => n.id === chosen)) return chosen;
      const succs = successors(graph, routeFromNode);
      const hit = succs.find((s) => s.when === chosen || s.to === chosen);
      if (hit) {
        return hit.to;
      }
    }

    const next = pickNext(graph, routeFromNode, state);
    if (next === END) return END;
    // If pickNext says handle_user but we already have a decision that failed to match, END safely
    if (next === HANDLE_USER_NODE && state.decision) return HANDLE_USER_NODE;
    if (next === HANDLE_USER_NODE && !state.decision) return HANDLE_USER_NODE;
    return next;
  });

  for (const node of graph.nodes) {
    if (node.id === HANDLE_USER_NODE) continue;
    builder.addConditionalEdges(node.id, (state: OrchestrationGraphState) => {
      if (state.status === 'failed') return END;
      if (state.status === 'completed' || state.decision?.complete) return END;
      // User interrupt mid-task → handle_user
      if (state.branch === 'status') return HANDLE_USER_NODE;
      if (state.decision?.branch && !isTaskNode(graph, node.id)) {
        const chosen = state.decision.branch;
        if (chosen === 'complete') return END;
        if (graph.nodes.some((n) => n.id === chosen)) return chosen;
      }
      const next = pickNext(graph, node.id, {
        ...state,
        // Clear one-shot status branch after routing intent
      });
      return next === END ? END : next;
    });
  }

  return {
    graph,
    entry,
    stateGraph: builder,
    allowedBranches: (from: string) => allowedBranches(graph, from),
    successors: (from: string) => successors(graph, from),
    bumpLoopCounts: (from: string, to: string, state: OrchestrationGraphState) =>
      bumpLoopCounts(graph, from, to, state),
    isTaskNode: (id: string) => isTaskNode(graph, id),
    nodeAgent: (id: string) => nodeAgent(graph, id),
  };
}

export type CompiledOrchestratorGraph = NonNullable<
  ReturnType<typeof compileOrchestratorLangGraph>
>;

/** Stable hash so we can cache compiled graphs per workspace. */
export function graphFingerprint(graph: OrchestratorGraph): string {
  return JSON.stringify({
    entry: graph.entry,
    nodes: graph.nodes,
    edges: graph.edges ?? [],
    loops: graph.loops ?? [],
  });
}

export type { OrchestratorGraphEdge, OrchestratorGraphLoop };

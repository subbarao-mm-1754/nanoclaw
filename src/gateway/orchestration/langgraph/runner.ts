/**
 * In-process LangGraph runner for multi-agent orchestrators.
 *
 * - One compiled graph per orchestrator workspace (from builder-stored JSON)
 * - One LangGraph thread per orchestration run id (multi-user / multi-conversation)
 * - Orchestrator LLM chooses among allowed branches only (graph/loops locked)
 */
import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { generateId } from '../../auth.js';
import { log } from '../../../log.js';
import { getGatewayDb } from '../../db/connection.js';
import { getWorkspace } from '../../store/workspaces.js';
import { isMultiAgentOrchestrationEnabled } from '../config.js';
import {
  appendOrchestrationEvent,
  createOrchestrationRun,
  getActiveOrchestrationRun,
  getOrchestrationRun,
  getOrchestratorGraph,
  listOrchestratorMembers,
  parseRunState,
  updateOrchestrationRun,
} from '../store.js';
import type { OrchestrationRun } from '../types.js';
import { resolveMemberByLocalName, wakeAgentWithText, wakeWorkspaceSession } from './a2a.js';
import {
  HANDLE_USER_NODE,
  compileOrchestratorLangGraph,
  graphFingerprint,
  type CompiledOrchestratorGraph,
} from './compile.js';
import type {
  InterruptPayload,
  OrchestrationGraphState,
  PendingWait,
  ResumePayload,
} from './state.js';

const checkpointer: BaseCheckpointSaver = new MemorySaver();

interface CachedCompile {
  fingerprint: string;
  compiled: CompiledOrchestratorGraph;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any;
}

const compileCache = new Map<string, CachedCompile>();

/** In-flight invoke locks per run id (avoid concurrent resume races). */
const runTails = new Map<string, Promise<unknown>>();

export interface LangGraphRunMeta {
  engine: 'langgraph';
  thread_id: string;
  fingerprint: string;
  orchestrator_session_id?: string;
  interrupt?: InterruptPayload | null;
  waiting_since?: string | null;
  nudge_count?: number;
  last_delegate_to?: string;
  last_message_id?: string;
  /** True when await_specialist targets the orchestrator workspace (intake/assemble). */
  self_task?: boolean;
}

function normAgentName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Agent name refers to the orchestrator itself (not a registered specialist member). */
export function isOrchestratorSelfAgent(
  orchestratorWorkspaceId: string,
  agent: string,
): boolean {
  const a = agent.trim().toLowerCase();
  if (!a || a === 'orchestrator') return true;
  if (resolveMemberByLocalName(orchestratorWorkspaceId, a)) return false;
  const orch = getWorkspace(orchestratorWorkspaceId);
  if (!orch) return false;
  return normAgentName(orch.name) === normAgentName(a);
}

async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = runTails.get(runId) ?? Promise.resolve();
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const tail = prev.then(
    () => done,
    () => done,
  );
  runTails.set(runId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    resolve();
    if (runTails.get(runId) === tail) runTails.delete(runId);
  }
}

function getCompiled(orchestratorWorkspaceId: string): CachedCompile | null {
  const graph = getOrchestratorGraph(orchestratorWorkspaceId);
  if (!graph?.nodes?.length) return null;
  const fingerprint = graphFingerprint(graph);
  const cached = compileCache.get(orchestratorWorkspaceId);
  if (cached && cached.fingerprint === fingerprint) return cached;

  const compiled = compileOrchestratorLangGraph(graph);
  if (!compiled) return null;
  const app = compiled.stateGraph.compile({ checkpointer: checkpointer as never });
  const entry: CachedCompile = { fingerprint, compiled, app };
  compileCache.set(orchestratorWorkspaceId, entry);
  return entry;
}

/** Drop compiled graph when builder re-registers. */
export function invalidateCompiledGraph(orchestratorWorkspaceId: string): void {
  compileCache.delete(orchestratorWorkspaceId);
}

function threadConfig(runId: string) {
  return { configurable: { thread_id: runId } };
}

function extractInterrupt(result: unknown): InterruptPayload | null {
  if (!result || typeof result !== 'object') return null;
  const interrupted = isInterrupted(result);
  if (!interrupted) return null;
  const bag = result as { __interrupt__?: Array<{ value?: unknown }> };
  const value = bag.__interrupt__?.[0]?.value;
  if (!value || typeof value !== 'object') return null;
  return value as InterruptPayload;
}

function mergeRunState(
  run: OrchestrationRun,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...parseRunState(run), ...patch };
}

function metaFromRun(run: OrchestrationRun): LangGraphRunMeta | null {
  const state = parseRunState(run);
  const lg = state.langgraph;
  if (!lg || typeof lg !== 'object') return null;
  return lg as LangGraphRunMeta;
}

function persistInterrupt(
  run: OrchestrationRun,
  interrupt: InterruptPayload | null,
  extra?: Record<string, unknown>,
): void {
  const prev = metaFromRun(run);
  const meta: LangGraphRunMeta = {
    engine: 'langgraph',
    thread_id: run.id,
    fingerprint: prev?.fingerprint ?? '',
    interrupt,
    waiting_since: interrupt ? new Date().toISOString() : null,
    nudge_count: interrupt ? (prev?.nudge_count ?? 0) : 0,
    last_delegate_to: prev?.last_delegate_to,
    last_message_id: prev?.last_message_id,
    ...extra,
  };

  const pending: PendingWait | null = interrupt
    ? {
        kind:
          interrupt.kind === 'await_specialist'
            ? 'specialist'
            : interrupt.kind === 'await_user'
              ? 'user'
              : 'decision',
        node_id: interrupt.node_id,
        agent: interrupt.kind === 'await_specialist' ? interrupt.agent : undefined,
        task_packet: interrupt.kind === 'await_specialist' ? interrupt.task_packet : undefined,
        allowed_branches:
          interrupt.kind === 'await_specialist' ? undefined : interrupt.allowed_branches,
        since: meta.waiting_since!,
        nudge_count: meta.nudge_count ?? 0,
      }
    : null;

  updateOrchestrationRun(run.id, {
    status: interrupt ? 'waiting' : run.status === 'waiting' ? 'running' : run.status,
    current_node: interrupt?.node_id ?? run.current_node,
    state: mergeRunState(run, {
      langgraph: meta,
      pending_wait: pending,
      ...(extra ?? {}),
    }),
  });
}

async function handleInterruptSideEffects(input: {
  run: OrchestrationRun;
  interrupt: InterruptPayload;
  orchestratorWorkspaceId: string;
  orchestratorSessionId: string;
  conversationId?: string | null;
}): Promise<void> {
  const { run, interrupt } = input;
  const orch = getWorkspace(input.orchestratorWorkspaceId);
  if (!orch) return;

  persistInterrupt(run, interrupt, {
    fingerprint: getCompiled(input.orchestratorWorkspaceId)?.fingerprint ?? '',
  });

  if (interrupt.kind === 'await_specialist') {
    const member = resolveMemberByLocalName(input.orchestratorWorkspaceId, interrupt.agent);
    if (!member) {
      // intake / assemble are often assigned to the orchestrator agent name (e.g. TripPlanner),
      // which is not in gateway_orchestrator_members — wake the orchestrator session instead.
      if (isOrchestratorSelfAgent(input.orchestratorWorkspaceId, interrupt.agent)) {
        const selfInterrupt: InterruptPayload = { ...interrupt, self: true };
        persistInterrupt(run, selfInterrupt, {
          fingerprint: getCompiled(input.orchestratorWorkspaceId)?.fingerprint ?? '',
          self_task: true,
        });
        appendOrchestrationEvent(run.id, 'delegate_self', {
          agent: interrupt.agent,
          node_id: interrupt.node_id,
        });
        const text = [
          `[LangGraph] Your turn — node "${interrupt.node_id}" (you are the assigned agent).`,
          `Goal: ${interrupt.goal || '(none)'}`,
          '',
          interrupt.task_packet,
          '',
          'Do this work now and reply to the user with the deliverable.',
          'When finished, the graph will advance automatically from your chat reply.',
          'To skip or revise, send_message to an allowed specialist, or choose complete / needs_revision.',
        ].join('\n');
        await wakeWorkspaceSession({
          workspaceId: orch.workspace_id,
          sessionId: input.orchestratorSessionId,
          agentGroupId: orch.agent_group_id,
          conversationId: input.conversationId,
          text,
          inboundMessageId: generateId('lgself'),
        });
        return;
      }

      log.warn('LangGraph: specialist not in members', {
        runId: run.id,
        agent: interrupt.agent,
      });
      appendOrchestrationEvent(run.id, 'delegate_failed', {
        agent: interrupt.agent,
        reason: 'member_not_found',
      });
      return;
    }

    const messageId = generateId('lgdel');
    const ok = await wakeAgentWithText({
      targetWorkspaceId: member.member_workspace_id,
      sourceWorkspaceId: orch.workspace_id,
      sourceAgentGroupId: orch.agent_group_id,
      sourceSessionId: input.orchestratorSessionId,
      conversationId: input.conversationId,
      text: interrupt.task_packet,
      inboundMessageId: messageId,
    });

    appendOrchestrationEvent(run.id, 'delegate', {
      to_workspace_id: member.member_workspace_id,
      to_agent_group_id: member.member_agent_group_id,
      agent: interrupt.agent,
      node_id: interrupt.node_id,
      message_id: messageId,
      ok,
    });

    const latest = getOrchestrationRun(run.id);
    if (latest) {
      persistInterrupt(latest, interrupt, {
        last_delegate_to: member.member_workspace_id,
        last_message_id: messageId,
        self_task: false,
      });
    }
    return;
  }

  appendOrchestrationEvent(run.id, 'await_decision', {
    node_id: interrupt.node_id,
    allowed_branches: interrupt.allowed_branches,
  });

  // Wake orchestrator on the user conversation session with locked-graph context.
  // Skip when this is the initial user-message path (processor already wakes the agent).
  if (Object.keys(interrupt.results_summary || {}).length > 0) {
    const allowed = interrupt.allowed_branches;
    const summaryLines = Object.entries(interrupt.results_summary || {}).map(
      ([k, v]) => `- ${k}: ${v}`,
    );
    const text = [
      '[LangGraph] Orchestrator decision required.',
      `Current node: ${interrupt.current_node}`,
      `Goal: ${interrupt.goal || '(none)'}`,
      `Allowed next branches (graph is locked — pick one; do not invent new nodes/loops): ${allowed.join(', ') || '(none)'}`,
      'Specialist results so far:',
      ...summaryLines,
      '',
      'Reply to the user as needed. To advance the graph, send_message to a specialist destination that matches an allowed branch, or choose an allowed when-label.',
      'You cannot change the registered graph, loops, or max_iterations.',
    ].join('\n');

    await wakeWorkspaceSession({
      workspaceId: orch.workspace_id,
      sessionId: input.orchestratorSessionId,
      agentGroupId: orch.agent_group_id,
      conversationId: input.conversationId,
      text,
      inboundMessageId: generateId('lgdec'),
    });
  }
}

async function invokeOrResume(input: {
  run: OrchestrationRun;
  compiled: CachedCompile;
  resume?: ResumePayload;
  initial?: Partial<OrchestrationGraphState>;
  orchestratorSessionId: string;
  conversationId?: string | null;
}): Promise<void> {
  const { run, compiled } = input;
  const cfg = threadConfig(run.id);

  let result: unknown;
  if (input.resume) {
    try {
      result = await compiled.app.invoke(new Command({ resume: input.resume }), cfg);
    } catch (err) {
      // Gateway restart drops MemorySaver checkpoints — rebuild from DB state.
      log.warn('LangGraph resume failed; re-invoking from stored run state', {
        runId: run.id,
        err,
      });
      const stored = parseRunState(run);
      const summary =
        (
          stored.langgraph as
            | { interrupt?: { results_summary?: Record<string, string>; node_id?: string } }
            | undefined
        )?.interrupt?.results_summary || {};
      const hydratedResults: OrchestrationGraphState['results'] = {
        ...((stored.results as OrchestrationGraphState['results']) || {}),
      };
      for (const [k, v] of Object.entries(summary)) {
        if (!hydratedResults[k]) {
          hydratedResults[k] = {
            text: String(v),
            from_agent: k,
            at: new Date().toISOString(),
          };
        }
      }
      const seed: Partial<OrchestrationGraphState> = {
        goal: run.goal ?? '',
        last_user_message:
          input.resume.kind === 'user'
            ? input.resume.text
            : String(stored.last_user_message || ''),
        user_messages:
          input.resume.kind === 'user' ? [input.resume.text] : [],
        current_node: (run.current_node as string) || HANDLE_USER_NODE,
        results: hydratedResults,
        loop_counts: (stored.loop_counts as Record<string, number>) || {},
        skip_nodes: (stored.skip_nodes as string[]) || [],
        status: 'running',
        branch: null,
        decision: null,
      };
      if (input.resume.kind === 'specialist') {
        const nodeId =
          (stored.langgraph as { interrupt?: { node_id?: string } } | undefined)?.interrupt
            ?.node_id || run.current_node || 'inbox';
        seed.results = {
          ...seed.results,
          [nodeId]: {
            text: input.resume.text,
            from_agent: input.resume.from_agent,
            message_id: input.resume.message_id,
            at: new Date().toISOString(),
            partial: input.resume.partial,
          },
        };
        seed.current_node = nodeId;
      }
      if (input.resume.kind === 'decision') {
        seed.decision = {
          branch: input.resume.branch,
          task_packet: input.resume.task_packet,
          skip_nodes: input.resume.skip_nodes,
          complete: input.resume.complete,
        };
        seed.branch = input.resume.branch;
      }
      result = await compiled.app.invoke(seed, cfg);
    }
  } else {
    result = await compiled.app.invoke(
      {
        goal: input.initial?.goal ?? run.goal ?? '',
        last_user_message: input.initial?.last_user_message ?? '',
        user_messages: input.initial?.user_messages ?? [],
        current_node: HANDLE_USER_NODE,
        status: 'running',
        ...(input.initial ?? {}),
      },
      cfg,
    );
  }

  const interrupt = extractInterrupt(result);
  const latest = getOrchestrationRun(run.id) ?? run;

  if (interrupt) {
    await handleInterruptSideEffects({
      run: latest,
      interrupt,
      orchestratorWorkspaceId: run.orchestrator_workspace_id,
      orchestratorSessionId: input.orchestratorSessionId,
      conversationId: input.conversationId ?? run.conversation_id,
    });
    return;
  }

  // Completed or failed terminal state
  const state = (result || {}) as Partial<OrchestrationGraphState>;
  updateOrchestrationRun(run.id, {
    status: state.status === 'failed' ? 'failed' : 'completed',
    current_node: state.current_node ?? run.current_node,
    state: mergeRunState(latest, {
      langgraph: {
        engine: 'langgraph',
        thread_id: run.id,
        fingerprint: compiled.fingerprint,
        interrupt: null,
        waiting_since: null,
        nudge_count: 0,
      },
      pending_wait: null,
      results: state.results ?? parseRunState(latest).results,
      branch: state.branch ?? null,
      error: state.error ?? null,
    }),
  });
  appendOrchestrationEvent(run.id, state.status === 'failed' ? 'failed' : 'completed', {
    error: state.error ?? null,
  });
}

/**
 * Ensure a LangGraph-backed run exists and process a user message.
 * Still allows the orchestrator container to be woken by the normal processor.
 */
export async function onOrchestratorUserMessage(input: {
  workspaceId: string;
  conversationId: string;
  sessionId: string;
  goalText: string;
}): Promise<OrchestrationRun | null> {
  if (!isMultiAgentOrchestrationEnabled()) return null;
  const ws = getWorkspace(input.workspaceId);
  if (!ws || ws.agent_kind !== 'orchestrator') return null;

  const compiled = getCompiled(input.workspaceId);
  if (!compiled) {
    // No fixed graph — soft mode (caller keeps legacy ensureOrchestrationRun).
    return null;
  }

  return withRunLock(`user:${input.workspaceId}:${input.conversationId}`, async () => {
    let run = getActiveOrchestrationRun(input.workspaceId, input.conversationId, {
      fallbackToAny: false,
    });

    // Soft runs created before LangGraph have no engine meta / interrupt. Close them
    // so the hard runner can own the next turn (otherwise we only annotate events).
    if (run) {
      const meta = metaFromRun(run);
      if (!meta || meta.engine !== 'langgraph') {
        updateOrchestrationRun(run.id, { status: 'completed' });
        appendOrchestrationEvent(run.id, 'completed', {
          reason: 'superseded_by_langgraph',
          note: 'Closed stale soft-orchestration run so LangGraph can start fresh',
        });
        run = null;
      }
    }

    if (!run) {
      run = createOrchestrationRun({
        orchestrator_workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        goal: input.goalText.slice(0, 2000),
        current_node: HANDLE_USER_NODE,
        state: {
          langgraph: {
            engine: 'langgraph',
            thread_id: '', // set below
            fingerprint: compiled.fingerprint,
            orchestrator_session_id: input.sessionId,
          } satisfies LangGraphRunMeta,
        },
      });
      // Fix thread_id = run.id
      updateOrchestrationRun(run.id, {
        state: mergeRunState(run, {
          langgraph: {
            engine: 'langgraph',
            thread_id: run.id,
            fingerprint: compiled.fingerprint,
            orchestrator_session_id: input.sessionId,
          },
        }),
      });
      run = getOrchestrationRun(run.id)!;
      appendOrchestrationEvent(run.id, 'started', {
        goal: input.goalText.slice(0, 200),
        engine: 'langgraph',
      });

      await invokeOrResume({
        run,
        compiled,
        initial: {
          goal: input.goalText.slice(0, 2000),
          last_user_message: input.goalText,
          user_messages: [input.goalText],
        },
        orchestratorSessionId: input.sessionId,
        conversationId: input.conversationId,
      });
      return getOrchestrationRun(run.id);
    }

    appendOrchestrationEvent(run.id, 'user_message', {
      preview: input.goalText.slice(0, 200),
      engine: 'langgraph',
    });

    const meta = metaFromRun(run);
    if (meta?.interrupt) {
      await invokeOrResume({
        run,
        compiled,
        resume: { kind: 'user', text: input.goalText },
        orchestratorSessionId: input.sessionId,
        conversationId: input.conversationId,
      });
    } else {
      // Not waiting — start a fresh decision cycle by updating state via resume-less
      // path is unsafe; use update + new interrupt by re-invoking handle_user.
      // If the graph already completed, open a new run.
      if (run.status === 'completed' || run.status === 'failed') {
        return run;
      }
      // Softly record; next specialist/decision path will pick it up.
      updateOrchestrationRun(run.id, {
        state: mergeRunState(run, {
          last_user_message: input.goalText,
        }),
      });
    }
    return getOrchestrationRun(run.id);
  });
}

/**
 * Specialist replied to orchestrator — resume await_specialist interrupt.
 */
export async function onSpecialistReply(input: {
  orchestratorWorkspaceId: string;
  conversationId?: string | null;
  orchestratorSessionId: string;
  fromWorkspaceId: string;
  fromLocalName?: string;
  text: string;
  messageId: string;
}): Promise<boolean> {
  if (!isMultiAgentOrchestrationEnabled()) return false;
  const compiled = getCompiled(input.orchestratorWorkspaceId);
  if (!compiled) return false;

  const run = getActiveOrchestrationRun(
    input.orchestratorWorkspaceId,
    input.conversationId,
    { fallbackToAny: input.conversationId ? false : true },
  );
  if (!run) return false;

  const meta = metaFromRun(run);
  const members = listOrchestratorMembers(input.orchestratorWorkspaceId);
  const fromMember = members.find((m) => m.member_workspace_id === input.fromWorkspaceId);
  const fromName = (input.fromLocalName || fromMember?.local_name || '').toLowerCase();

  if (!meta?.interrupt || meta.interrupt.kind !== 'await_specialist') {
    // Graph already moved on (or soft path wiped interrupt meta) — keep the result.
    await recordLateSpecialistReply({
      run,
      fromWorkspaceId: input.fromWorkspaceId,
      fromLocalName: fromName || undefined,
      text: input.text,
      messageId: input.messageId,
    });
    return false;
  }

  const expectedAgent = meta.interrupt.agent;
  if (expectedAgent && fromName && expectedAgent !== fromName) {
    // Do not resume the wrong node with another specialist's payload (this is what
    // stamped logistics text onto assemble after tripplanner member_not_found).
    log.info('LangGraph: rejecting specialist reply from unexpected agent', {
      runId: run.id,
      expectedAgent,
      fromName,
    });
    await recordLateSpecialistReply({
      run,
      fromWorkspaceId: input.fromWorkspaceId,
      fromLocalName: fromName || undefined,
      text: input.text,
      messageId: input.messageId,
    });
    appendOrchestrationEvent(run.id, 'specialist_reply_rejected', {
      from_workspace_id: input.fromWorkspaceId,
      expected_agent: expectedAgent,
      from_agent: fromName,
    });
    return false;
  }

  await withRunLock(run.id, async () => {
    const nodeId = meta.interrupt!.node_id;
    const prev = parseRunState(run);
    updateOrchestrationRun(run.id, {
      state: mergeRunState(run, {
        results: {
          ...((prev.results as Record<string, unknown>) || {}),
          [nodeId]: {
            text: input.text,
            from_agent: fromName || expectedAgent || 'specialist',
            message_id: input.messageId,
            at: new Date().toISOString(),
          },
        },
      }),
    });
    appendOrchestrationEvent(run.id, 'specialist_reply', {
      from_workspace_id: input.fromWorkspaceId,
      message_id: input.messageId,
      engine: 'langgraph',
      node_id: nodeId,
    });
    const latest = getOrchestrationRun(run.id) ?? run;
    await invokeOrResume({
      run: latest,
      compiled,
      resume: {
        kind: 'specialist',
        text: input.text,
        from_agent: fromName || expectedAgent || 'specialist',
        message_id: input.messageId,
      },
      orchestratorSessionId: meta.orchestrator_session_id || input.orchestratorSessionId,
      conversationId: input.conversationId,
    });
  });

  return true;
}

/**
 * Orchestrator finished an intake/assemble (self) node by sending a user-facing chat reply.
 * Resumes await_specialist and lets the graph auto-advance.
 */
export async function onOrchestratorSelfTaskComplete(input: {
  orchestratorWorkspaceId: string;
  conversationId?: string | null;
  orchestratorSessionId: string;
  text: string;
  messageId?: string;
}): Promise<boolean> {
  if (!isMultiAgentOrchestrationEnabled()) return false;
  const compiled = getCompiled(input.orchestratorWorkspaceId);
  if (!compiled) return false;

  const run = getActiveOrchestrationRun(
    input.orchestratorWorkspaceId,
    input.conversationId,
    { fallbackToAny: input.conversationId ? false : true },
  );
  if (!run) return false;

  const meta = metaFromRun(run);
  if (!meta?.interrupt || meta.interrupt.kind !== 'await_specialist') return false;
  if (!meta.interrupt.self && !meta.self_task) return false;
  if (!isOrchestratorSelfAgent(input.orchestratorWorkspaceId, meta.interrupt.agent)) {
    return false;
  }

  const nodeId = meta.interrupt.node_id;
  const agent = meta.interrupt.agent || 'orchestrator';

  await withRunLock(run.id, async () => {
    const prev = parseRunState(run);
    updateOrchestrationRun(run.id, {
      state: mergeRunState(run, {
        results: {
          ...((prev.results as Record<string, unknown>) || {}),
          [nodeId]: {
            text: input.text,
            from_agent: agent,
            message_id: input.messageId,
            at: new Date().toISOString(),
          },
        },
      }),
    });
    appendOrchestrationEvent(run.id, 'self_task_complete', {
      node_id: nodeId,
      agent,
      message_id: input.messageId ?? null,
    });
    const latest = getOrchestrationRun(run.id) ?? run;
    await invokeOrResume({
      run: latest,
      compiled,
      resume: {
        kind: 'specialist',
        text: input.text,
        from_agent: agent,
        message_id: input.messageId,
      },
      orchestratorSessionId: meta.orchestrator_session_id || input.orchestratorSessionId,
      conversationId: input.conversationId,
    });
  });

  return true;
}

async function recordLateSpecialistReply(input: {
  run: import('../types.js').OrchestrationRun;
  fromWorkspaceId: string;
  fromLocalName?: string;
  text: string;
  messageId: string;
}): Promise<void> {
  const prev = parseRunState(input.run);
  const key = input.fromLocalName || input.fromWorkspaceId;
  appendOrchestrationEvent(input.run.id, 'late_specialist_reply', {
    from_workspace_id: input.fromWorkspaceId,
    message_id: input.messageId,
    note: 'Reply arrived after graph left await_specialist (or state was clobbered)',
  });
  updateOrchestrationRun(input.run.id, {
    state: {
      ...prev,
      results: {
        ...((prev.results as Record<string, unknown>) || {}),
        [key]: {
          text: input.text,
          from_agent: input.fromLocalName || key,
          message_id: input.messageId,
          at: new Date().toISOString(),
          late: true,
        },
      },
    },
  });
}

/**
 * Map orchestrator send_message / decision onto an allowed graph branch.
 * Returns true when the graph consumed the decision (caller may still route A2A
 * if the branch targets a specialist and the graph is not auto-delegating yet).
 */
export async function onOrchestratorDecision(input: {
  orchestratorWorkspaceId: string;
  conversationId?: string | null;
  orchestratorSessionId: string;
  /** Destination local_name or node id / when label. */
  branch: string;
  taskPacket?: string;
  skipNodes?: string[];
  complete?: boolean;
}): Promise<{ handled: boolean; autoDelegating: boolean }> {
  if (!isMultiAgentOrchestrationEnabled()) {
    return { handled: false, autoDelegating: false };
  }
  const compiled = getCompiled(input.orchestratorWorkspaceId);
  if (!compiled) return { handled: false, autoDelegating: false };

  const run = getActiveOrchestrationRun(
    input.orchestratorWorkspaceId,
    input.conversationId,
    { fallbackToAny: input.conversationId ? false : true },
  );
  if (!run) return { handled: false, autoDelegating: false };

  const meta = metaFromRun(run);
  if (!meta?.interrupt) {
    // Soft run (or lost MemorySaver interrupt) — reclaim so soft A2A loops cannot
    // own the conversation and starve Cliq replies.
    if (!meta || meta.engine !== 'langgraph') {
      updateOrchestrationRun(run.id, { status: 'completed' });
      appendOrchestrationEvent(run.id, 'completed', {
        reason: 'superseded_by_langgraph_reclaim',
        note: 'Closed soft/interrupt-less run on orchestrator decision',
      });
      const fresh = await onOrchestratorUserMessage({
        workspaceId: input.orchestratorWorkspaceId,
        conversationId: input.conversationId || run.conversation_id || 'unknown',
        sessionId: input.orchestratorSessionId,
        goalText: input.taskPacket || run.goal || input.branch,
      });
      if (fresh) {
        return onOrchestratorDecision(input);
      }
    }
    return { handled: false, autoDelegating: false };
  }
  if (meta.interrupt.kind === 'await_specialist') {
    // Hard wait: do not abandon the specialist because the orchestrator LLM
    // send_message'd someone else. Only same-node / status / complete may resume.
    const waitingAgent = (meta.interrupt.agent || '').toLowerCase();
    const waitingNode = meta.interrupt.node_id.toLowerCase();
    const branch = input.branch.trim().toLowerCase();
    const sameWait =
      branch === waitingAgent ||
      branch === waitingNode ||
      branch === 'status' ||
      branch === 'complete';
    if (!sameWait) {
      appendOrchestrationEvent(run.id, 'decision_ignored_while_waiting', {
        branch: input.branch,
        waiting_node: meta.interrupt.node_id,
        waiting_agent: meta.interrupt.agent,
      });
      log.info('LangGraph: ignoring orchestrator branch while waiting on specialist', {
        runId: run.id,
        branch: input.branch,
        waitingNode: meta.interrupt.node_id,
        waitingAgent: meta.interrupt.agent,
      });
      return { handled: true, autoDelegating: false };
    }
  } else if (
    meta.interrupt.kind === 'await_decision' ||
    meta.interrupt.kind === 'await_user'
  ) {
    const allowed = new Set(meta.interrupt.allowed_branches.map((b) => b.toLowerCase()));
    const branch = input.branch.trim().toLowerCase();
    // Also allow choosing by specialist agent name → node id
    const nodeForAgent = compiled.compiled.graph.nodes.find(
      (n) => (n.agent || '').toLowerCase() === branch,
    );
    const normalized = nodeForAgent?.id ?? branch;
    if (
      !allowed.has(branch) &&
      !allowed.has(normalized) &&
      !compiled.compiled.graph.nodes.some((n) => n.id === normalized)
    ) {
      appendOrchestrationEvent(run.id, 'decision_rejected', {
        branch: input.branch,
        allowed: meta.interrupt.allowed_branches,
        reason: 'not_in_allowed_branches',
      });
      log.warn('LangGraph: orchestrator chose a branch outside the locked graph', {
        runId: run.id,
        branch: input.branch,
        allowed: meta.interrupt.allowed_branches,
      });
      return { handled: true, autoDelegating: false };
    }
  }

  const branch =
    compiled.compiled.graph.nodes.find(
      (n) => (n.agent || '').toLowerCase() === input.branch.trim().toLowerCase(),
    )?.id ?? input.branch.trim();

  // Loop enforcement: if this branch is a loop and exhausted, reject.
  const from =
    meta.interrupt.node_id === HANDLE_USER_NODE
      ? compiled.compiled.entry
      : meta.interrupt.node_id;
  const bumps = compiled.compiled.bumpLoopCounts(
    from,
    branch,
    {
      loop_counts: (parseRunState(run).loop_counts as Record<string, number>) || {},
    } as OrchestrationGraphState,
  );
  if (bumps) {
    const key = Object.keys(bumps)[0]!;
    const loop = (compiled.compiled.graph.loops ?? []).find(
      (l) => `${l.from}->${l.to}` === key || (l.from === from && l.to === branch),
    );
    const max = loop?.max_iterations ?? 2;
    if ((bumps[key] ?? 0) > max) {
      appendOrchestrationEvent(run.id, 'loop_exhausted', { key, max });
      return { handled: true, autoDelegating: false };
    }
    updateOrchestrationRun(run.id, {
      state: mergeRunState(run, { loop_counts: { ...((parseRunState(run).loop_counts as object) || {}), ...bumps } }),
    });
  }

  await withRunLock(run.id, async () => {
    appendOrchestrationEvent(run.id, 'decision', {
      branch,
      engine: 'langgraph',
    });
    const latest = getOrchestrationRun(run.id) ?? run;
    await invokeOrResume({
      run: latest,
      compiled,
      resume: {
        kind: 'decision',
        branch,
        task_packet: input.taskPacket,
        skip_nodes: input.skipNodes,
        complete: input.complete,
      },
      orchestratorSessionId: input.orchestratorSessionId,
      conversationId: input.conversationId,
    });
  });

  // After decision, runner auto-delegates if the next interrupt is await_specialist.
  const after = getOrchestrationRun(run.id);
  const afterMeta = after ? metaFromRun(after) : null;
  return {
    handled: true,
    autoDelegating: afterMeta?.interrupt?.kind === 'await_specialist',
  };
}

/** Resolve local_name for a member workspace under an orchestrator. */
export function localNameForMember(
  orchestratorWorkspaceId: string,
  memberWorkspaceId: string,
): string | null {
  const m = listOrchestratorMembers(orchestratorWorkspaceId).find(
    (x) => x.member_workspace_id === memberWorkspaceId,
  );
  return m?.local_name ?? null;
}

export function isLangGraphOrchestrator(workspaceId: string): boolean {
  return getCompiled(workspaceId) !== null;
}

export function getRunInterrupt(runId: string): InterruptPayload | null {
  const run = getOrchestrationRun(runId);
  if (!run) return null;
  return metaFromRun(run)?.interrupt ?? null;
}

/** Used by nudge tick. */
export function listWaitingLangGraphRuns(limit = 50): OrchestrationRun[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_orchestration_runs
       WHERE status = 'waiting'
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    orchestrator_workspace_id: row.orchestrator_workspace_id as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    status: row.status as OrchestrationRun['status'],
    current_node: (row.current_node as string | null) ?? null,
    state_json: (row.state_json as string) || '{}',
    goal: (row.goal as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}

export async function resumeTimeout(
  run: OrchestrationRun,
  action: 'nudge' | 'fail' | 'partial',
  opts?: { partialText?: string; orchestratorSessionId?: string },
): Promise<void> {
  const compiled = getCompiled(run.orchestrator_workspace_id);
  if (!compiled) return;
  const meta = metaFromRun(run);
  if (!meta?.interrupt) return;

  if (action === 'nudge' && meta.interrupt.kind === 'await_specialist') {
    const orch = getWorkspace(run.orchestrator_workspace_id);
    if (!orch) return;

    if (meta.interrupt.self || meta.self_task || isOrchestratorSelfAgent(run.orchestrator_workspace_id, meta.interrupt.agent)) {
      const nudgeText = [
        'NUDGE: Please finish the orchestrator task below (partial deliverable is OK) and reply to the user.',
        'Original task:',
        meta.interrupt.task_packet,
      ].join('\n');
      await wakeWorkspaceSession({
        workspaceId: orch.workspace_id,
        sessionId: opts?.orchestratorSessionId || meta.orchestrator_session_id || `sess-nudge-${run.id}`,
        agentGroupId: orch.agent_group_id,
        conversationId: run.conversation_id,
        text: nudgeText,
        inboundMessageId: generateId('lgnudge'),
      });
      appendOrchestrationEvent(run.id, 'nudge', {
        agent: meta.interrupt.agent,
        node_id: meta.interrupt.node_id,
        self: true,
      });
      updateOrchestrationRun(run.id, {
        state: mergeRunState(run, {
          langgraph: { ...meta, nudge_count: (meta.nudge_count ?? 0) + 1 },
        }),
      });
      return;
    }

    const member = resolveMemberByLocalName(
      run.orchestrator_workspace_id,
      meta.interrupt.agent,
    );
    if (member) {
      const nudgeText = [
        'NUDGE: Please return whatever result you have now (partial is OK).',
        'Original task:',
        meta.interrupt.task_packet,
      ].join('\n');
      await wakeAgentWithText({
        targetWorkspaceId: member.member_workspace_id,
        sourceWorkspaceId: orch.workspace_id,
        sourceAgentGroupId: orch.agent_group_id,
        sourceSessionId: opts?.orchestratorSessionId || `sess-nudge-${run.id}`,
        conversationId: run.conversation_id,
        text: nudgeText,
        inboundMessageId: generateId('lgnudge'),
      });
      appendOrchestrationEvent(run.id, 'nudge', {
        agent: meta.interrupt.agent,
        node_id: meta.interrupt.node_id,
      });
      updateOrchestrationRun(run.id, {
        state: mergeRunState(run, {
          langgraph: { ...meta, nudge_count: (meta.nudge_count ?? 0) + 1 },
        }),
      });
    }
    return;
  }

  await withRunLock(run.id, async () => {
    await invokeOrResume({
      run,
      compiled,
      resume: {
        kind: 'timeout',
        action,
        partial_text: opts?.partialText,
      },
      orchestratorSessionId: opts?.orchestratorSessionId || `sess-nudge-${run.id}`,
      conversationId: run.conversation_id,
    });
  });
}

/** Test helper */
export function _resetLangGraphRuntimeForTests(): void {
  compileCache.clear();
  runTails.clear();
}

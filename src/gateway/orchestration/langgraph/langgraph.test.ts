import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../../db/connection.js';
import { createUser } from '../../store/users.js';
import { createAgentRecord } from '../../store/agents.js';
import { ORCHESTRATION_SETTING_KEY } from '../config.js';
import { deleteGatewaySetting } from '../../store/settings.js';
import {
  getActiveOrchestrationRun,
  parseRunState,
  replaceOrchestratorMembers,
  saveOrchestratorGraph,
} from '../store.js';
import {
  HANDLE_USER_NODE,
  _resetLangGraphRuntimeForTests,
  compileOrchestratorLangGraph,
  isLangGraphOrchestrator,
  onOrchestratorDecision,
  onOrchestratorUserMessage,
  onSpecialistReply,
  resolveGraphNext,
} from './index.js';
import type { OrchestratorGraph } from '../types.js';

vi.mock('./a2a.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./a2a.js')>();
  return {
    ...actual,
    wakeAgentWithText: vi.fn(async () => true),
    wakeWorkspaceSession: vi.fn(async () => true),
  };
});

beforeEach(() => {
  initGatewayTestDb();
  deleteGatewaySetting(ORCHESTRATION_SETTING_KEY);
  _resetLangGraphRuntimeForTests();
});

afterEach(() => {
  closeGatewayDb();
  _resetLangGraphRuntimeForTests();
});

const sampleGraph: OrchestratorGraph = {
  entry: 'research',
  nodes: [
    { id: 'research', agent: 'researcher', type: 'task', description: 'Find sources' },
    { id: 'write', agent: 'writer', type: 'task' },
  ],
  edges: [{ from: 'research', to: 'write' }],
  loops: [{ from: 'write', to: 'research', max_iterations: 2, when: 'retry' }],
};

describe('LangGraph orchestration', () => {
  it('compiles a builder graph with handle_user hub', () => {
    const compiled = compileOrchestratorLangGraph(sampleGraph);
    expect(compiled).not.toBeNull();
    expect(compiled!.entry).toBe('research');
    expect(compiled!.isTaskNode('research')).toBe(true);
    expect(compiled!.nodeAgent('research')).toBe('researcher');
    expect(compiled!.allowedBranches('research')).toContain('write');
    expect(compiled!.allowedBranches('write')).toContain('retry');
  });

  it('returns null for empty graphs (soft mode)', () => {
    expect(compileOrchestratorLangGraph({ nodes: [] })).toBeNull();
    expect(compileOrchestratorLangGraph(null)).toBeNull();
  });

  it('auto-advances parallel fan-out and join (research → images/logistics → assemble)', () => {
    const tripGraph: OrchestratorGraph = {
      entry: 'intake',
      nodes: [
        { id: 'intake', agent: 'TripPlanner', type: 'task' },
        { id: 'research', agent: 'trip-researcher', type: 'task' },
        { id: 'images', agent: 'scout-images', type: 'task' },
        { id: 'logistics', agent: 'logistics', type: 'task' },
        { id: 'assemble', agent: 'TripPlanner', type: 'task' },
      ],
      edges: [
        { from: 'intake', to: 'research' },
        { from: 'research', to: 'images' },
        { from: 'research', to: 'logistics' },
        { from: 'images', to: 'assemble' },
        { from: 'logistics', to: 'assemble' },
      ],
    };

    expect(
      resolveGraphNext(tripGraph, 'research', {
        results: { research: { text: 'ok', from_agent: 'trip-researcher', at: '' } },
      }),
    ).toBe('images');

    expect(
      resolveGraphNext(tripGraph, 'images', {
        results: {
          research: { text: 'ok', from_agent: 'r', at: '' },
          images: { text: 'photos', from_agent: 's', at: '' },
        },
      }),
    ).toBe('logistics');

    expect(
      resolveGraphNext(tripGraph, 'logistics', {
        results: {
          research: { text: 'ok', from_agent: 'r', at: '' },
          images: { text: 'photos', from_agent: 's', at: '' },
          logistics: { text: 'budget', from_agent: 'l', at: '' },
        },
      }),
    ).toBe('assemble');

    // Join: logistics done but images missing → images first (not assemble / handle_user).
    expect(
      resolveGraphNext(tripGraph, 'logistics', {
        results: {
          research: { text: 'ok', from_agent: 'r', at: '' },
          logistics: { text: 'budget', from_agent: 'l', at: '' },
        },
      }),
    ).toBe('images');

    // Already parked on assemble without images → still pull images.
    expect(
      resolveGraphNext(tripGraph, 'assemble', {
        results: {
          research: { text: 'ok', from_agent: 'r', at: '' },
          logistics: { text: 'budget', from_agent: 'l', at: '' },
          assemble: { text: 'bogus', from_agent: 'logistics', at: '' },
        },
      }),
    ).toBe('images');
  });

  it('isolates runs per conversation and advances on decisions + specialist replies', async () => {
    const user = createUser({
      email: 'lg@test.com',
      password: 'password123',
      display_name: 'LG',
    });
    const orch = createAgentRecord({
      name: 'Lead',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# o' }],
      agent_kind: 'orchestrator',
    });
    const researcher = createAgentRecord({
      name: 'Researcher',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# r' }],
      agent_kind: 'agent',
    });
    const writer = createAgentRecord({
      name: 'Writer',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# w' }],
      agent_kind: 'agent',
    });

    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: researcher.workspace_id,
        member_agent_group_id: researcher.agent_group_id,
        local_name: 'researcher',
      },
      {
        member_workspace_id: writer.workspace_id,
        member_agent_group_id: writer.agent_group_id,
        local_name: 'writer',
      },
    ]);
    saveOrchestratorGraph(orch.workspace_id, sampleGraph);
    expect(isLangGraphOrchestrator(orch.workspace_id)).toBe(true);

    const runA = await onOrchestratorUserMessage({
      workspaceId: orch.workspace_id,
      conversationId: 'conv-a',
      sessionId: 'sess-a',
      goalText: 'Research topic A',
    });
    const runB = await onOrchestratorUserMessage({
      workspaceId: orch.workspace_id,
      conversationId: 'conv-b',
      sessionId: 'sess-b',
      goalText: 'Research topic B',
    });

    expect(runA?.id).toBeTruthy();
    expect(runB?.id).toBeTruthy();
    expect(runA!.id).not.toBe(runB!.id);
    expect(runA!.status).toBe('waiting');
    expect(parseRunState(runA!).langgraph).toMatchObject({
      engine: 'langgraph',
      thread_id: runA!.id,
    });

    // User A: orchestrator chooses researcher
    const d1 = await onOrchestratorDecision({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-a',
      orchestratorSessionId: 'sess-a',
      branch: 'researcher',
      taskPacket: 'Find sources for A',
    });
    expect(d1.handled).toBe(true);
    expect(d1.autoDelegating).toBe(true);

    const waitingA = getActiveOrchestrationRun(orch.workspace_id, 'conv-a');
    expect(waitingA?.status).toBe('waiting');
    expect(waitingA?.current_node).toBe('research');

    // Specialist reply for A
    const handled = await onSpecialistReply({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-a',
      orchestratorSessionId: 'sess-a',
      fromWorkspaceId: researcher.workspace_id,
      fromLocalName: 'researcher',
      text: 'Sources: 1, 2, 3',
      messageId: 'msg-1',
    });
    expect(handled).toBe(true);

    // Conversation B still independent / waiting on its own decision
    const stillB = getActiveOrchestrationRun(orch.workspace_id, 'conv-b');
    expect(stillB?.id).toBe(runB!.id);
    expect(stillB?.status).toBe('waiting');
    expect(stillB?.current_node).toBe(HANDLE_USER_NODE);
  });

  it('rejects branches outside the locked graph', async () => {
    const user = createUser({
      email: 'lg2@test.com',
      password: 'password123',
      display_name: 'LG2',
    });
    const orch = createAgentRecord({
      name: 'Lead2',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# o' }],
      agent_kind: 'orchestrator',
    });
    const researcher = createAgentRecord({
      name: 'Researcher2',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# r' }],
      agent_kind: 'agent',
    });
    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: researcher.workspace_id,
        member_agent_group_id: researcher.agent_group_id,
        local_name: 'researcher',
      },
    ]);
    saveOrchestratorGraph(orch.workspace_id, {
      entry: 'research',
      nodes: [{ id: 'research', agent: 'researcher', type: 'task' }],
      edges: [],
    });

    await onOrchestratorUserMessage({
      workspaceId: orch.workspace_id,
      conversationId: 'conv-x',
      sessionId: 'sess-x',
      goalText: 'Go',
    });

    const rejected = await onOrchestratorDecision({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-x',
      orchestratorSessionId: 'sess-x',
      branch: 'totally-invented-node',
    });
    expect(rejected.handled).toBe(true);
    expect(rejected.autoDelegating).toBe(false);
    expect(getActiveOrchestrationRun(orch.workspace_id, 'conv-x')?.status).toBe('waiting');
  });

  it('does not advance the graph on ack/progress; advances on completed', async () => {
    const user = createUser({
      email: 'lg-proto@test.com',
      password: 'password123',
      display_name: 'LGProto',
    });
    const orch = createAgentRecord({
      name: 'LeadProto',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# o' }],
      agent_kind: 'orchestrator',
    });
    const researcher = createAgentRecord({
      name: 'ResearcherProto',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# r' }],
      agent_kind: 'agent',
    });
    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: researcher.workspace_id,
        member_agent_group_id: researcher.agent_group_id,
        local_name: 'researcher',
      },
    ]);
    saveOrchestratorGraph(orch.workspace_id, {
      entry: 'research',
      nodes: [{ id: 'research', agent: 'researcher', type: 'task' }],
      edges: [],
    });

    await onOrchestratorUserMessage({
      workspaceId: orch.workspace_id,
      conversationId: 'conv-proto',
      sessionId: 'sess-proto',
      goalText: 'Research topic',
    });
    await onOrchestratorDecision({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-proto',
      orchestratorSessionId: 'sess-proto',
      branch: 'research',
      taskPacket: 'Find sources',
    });

    const waiting = getActiveOrchestrationRun(orch.workspace_id, 'conv-proto');
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.current_node).toBe('research');

    const ackHandled = await onSpecialistReply({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-proto',
      orchestratorSessionId: 'sess-proto',
      fromWorkspaceId: researcher.workspace_id,
      fromLocalName: 'researcher',
      text: 'On it — researching…',
      messageId: 'msg-ack',
      content: {
        text: 'On it — researching…',
        orchestration: { status: 'ack' },
      },
    });
    expect(ackHandled).toBe(true);
    const stillWaiting = getActiveOrchestrationRun(orch.workspace_id, 'conv-proto');
    expect(stillWaiting?.status).toBe('waiting');
    expect(stillWaiting?.current_node).toBe('research');
    expect((parseRunState(stillWaiting!).results as Record<string, unknown>)?.research).toBeUndefined();

    const done = await onSpecialistReply({
      orchestratorWorkspaceId: orch.workspace_id,
      conversationId: 'conv-proto',
      orchestratorSessionId: 'sess-proto',
      fromWorkspaceId: researcher.workspace_id,
      fromLocalName: 'researcher',
      text: 'Sources: A, B',
      messageId: 'msg-done',
      content: {
        text: 'Sources: A, B',
        orchestration: { status: 'completed', payload: 'Sources: A, B' },
      },
    });
    expect(done).toBe(true);
    const { getOrchestrationRun } = await import('../store.js');
    const runAfter = getOrchestrationRun(waiting!.id)!;
    const finalResults = parseRunState(runAfter).results as Record<
      string,
      { status?: string; text?: string }
    >;
    expect(finalResults.research?.status).toBe('completed');
    expect(finalResults.research?.text).toContain('Sources');
    // Interrupt cleared / run left waiting-for-specialist.
    const lg = parseRunState(runAfter).langgraph as { interrupt?: { kind?: string } | null } | undefined;
    expect(lg?.interrupt?.kind === 'await_specialist').toBe(false);
    expect(['completed', 'waiting', 'running']).toContain(runAfter.status);
    if (runAfter.status === 'waiting') {
      expect(runAfter.current_node).not.toBe('research');
    }
  });
});

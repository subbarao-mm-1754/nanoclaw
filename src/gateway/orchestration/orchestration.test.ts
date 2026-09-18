import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import { createAgentRecord } from '../store/agents.js';
import { parseBuildResultFromText } from '../builder/parse-result.js';
import { composeOrchestratorFiles } from './compose.js';
import { isMultiAgentOrchestrationEnabled, ORCHESTRATION_SETTING_KEY } from './config.js';
import { formatOrchestratorProposal } from './register.js';
import {
  appendOrchestrationEvent,
  createOrchestrationRun,
  getActiveOrchestrationRun,
  getActiveRunSummary,
  getOrchestrationOverview,
  getOrchestratorGraph,
  listOrchestrationRuns,
  listOrchestratorMembers,
  replaceOrchestratorMembers,
  saveOrchestratorGraph,
} from './store.js';
import { setGatewaySetting, deleteGatewaySetting } from '../store/settings.js';
import { extraDestinationsForWorkspace } from './destinations.js';

beforeEach(() => {
  initGatewayTestDb();
  deleteGatewaySetting(ORCHESTRATION_SETTING_KEY);
});

afterEach(() => {
  closeGatewayDb();
});

describe('multi-agent orchestration', () => {
  it('parses orchestrator build fence with specialists and graph', () => {
    const text = `Ready

\`\`\`nanoclaw-build
{
  "status": "completed",
  "agent_kind": "orchestrator",
  "agent_name": "Research Lead",
  "confirmation_required": true,
  "files": [{ "path": "CLAUDE.local.md", "content": "# Lead" }],
  "specialists": [
    {
      "name": "researcher",
      "action": "create",
      "agent_name": "Researcher",
      "files": [{ "path": "CLAUDE.local.md", "content": "# R" }]
    },
    { "name": "browser", "action": "reuse", "reuse_name": "WebBot" }
  ],
  "graph": {
    "entry": "research",
    "nodes": [
      { "id": "research", "agent": "researcher", "type": "task" },
      { "id": "browse", "agent": "browser", "type": "task" }
    ],
    "edges": [{ "from": "research", "to": "browse" }],
    "loops": [{ "from": "browse", "to": "research", "max_iterations": 2 }]
  }
}
\`\`\``;

    const parsed = parseBuildResultFromText(text);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.agent_kind).toBe('orchestrator');
    expect(parsed?.specialists).toHaveLength(2);
    expect(parsed?.specialists?.[1]?.action).toBe('reuse');
    expect(parsed?.graph?.loops?.[0]?.max_iterations).toBe(2);
  });

  it('composes orchestration appendix into CLAUDE.local.md', () => {
    const files = composeOrchestratorFiles({
      files: [{ path: 'CLAUDE.local.md', content: '# Lead\nBe helpful.' }],
      specialists: [
        { name: 'researcher', action: 'create', role: 'find sources' },
        { name: 'writer', action: 'reuse' },
      ],
      graph: {
        entry: 'research',
        nodes: [{ id: 'research', agent: 'researcher', type: 'task' }],
      },
    });
    expect(files[0]!.content).toContain('Multi-agent orchestration');
    expect(files[0]!.content).toContain('`researcher`');
    expect(files[0]!.content).toContain('Registered graph');
    expect(files[0]!.content).toContain('Specialist reply protocol');
  });

  it('composes specialist reporting protocol into CLAUDE.local.md', async () => {
    const { composeSpecialistFiles } = await import('./compose.js');
    const files = composeSpecialistFiles({
      files: [{ path: 'CLAUDE.local.md', content: '# Researcher\nFind places.' }],
      localName: 'trip-researcher',
      role: 'research places',
    });
    expect(files[0]!.content).toContain('Reporting to the orchestrator');
    expect(files[0]!.content).toContain('orchestration_status');
    expect(files[0]!.content).toContain('ack');
  });

  it('stores members, graph, and run state; destinations include specialists', () => {
    const user = createUser({
      email: 'orch@test.com',
      password: 'password123',
      display_name: 'Orch',
    });
    const orch = createAgentRecord({
      name: 'Lead',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# o' }],
      agent_kind: 'orchestrator',
    });
    const spec = createAgentRecord({
      name: 'Spec',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# s' }],
      agent_kind: 'agent',
    });

    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: spec.workspace_id,
        member_agent_group_id: spec.agent_group_id,
        local_name: 'researcher',
        role: 'research',
      },
    ]);
    saveOrchestratorGraph(orch.workspace_id, {
      entry: 'n1',
      nodes: [{ id: 'n1', agent: 'researcher' }],
    });

    expect(listOrchestratorMembers(orch.workspace_id)).toHaveLength(1);
    expect(getOrchestratorGraph(orch.workspace_id)?.entry).toBe('n1');

    const dests = extraDestinationsForWorkspace(orch.workspace_id);
    expect(dests.some((d) => d.name === 'researcher' && d.type === 'agent')).toBe(true);

    const run = createOrchestrationRun({
      orchestrator_workspace_id: orch.workspace_id,
      conversation_id: 'conv-1',
      goal: 'find news',
    });
    expect(getActiveOrchestrationRun(orch.workspace_id, 'conv-1')?.id).toBe(run.id);
  });

  it('formats proposal text for Cliq confirmation', () => {
    const text = formatOrchestratorProposal({
      status: 'completed',
      agent_name: 'Team Lead',
      specialists: [
        { name: 'a', action: 'create', agent_name: 'Agent A' },
        { name: 'b', action: 'reuse', reuse_name: 'OldBot' },
      ],
      graph: { entry: 'a', nodes: [{ id: 'a', agent: 'a' }] },
    });
    expect(text).toContain('orchestrator');
    expect(text).toContain('/register');
    expect(text).toContain('reuse existing');
  });

  it('lists runs and overview for studio', () => {
    const user = createUser({
      email: 'studio@test.com',
      password: 'password123',
      display_name: 'Studio',
    });
    const orch = createAgentRecord({
      name: 'Lead',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# o' }],
      agent_kind: 'orchestrator',
    });
    const spec = createAgentRecord({
      name: 'Spec',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# s' }],
      agent_kind: 'agent',
    });
    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: spec.workspace_id,
        member_agent_group_id: spec.agent_group_id,
        local_name: 'researcher',
      },
    ]);
    saveOrchestratorGraph(orch.workspace_id, {
      entry: 'n1',
      nodes: [{ id: 'n1', agent: 'researcher' }],
      loops: [{ from: 'n1', to: 'n1', max_iterations: 2 }],
    });
    const run = createOrchestrationRun({
      orchestrator_workspace_id: orch.workspace_id,
      goal: 'demo',
      current_node: 'n1',
    });
    appendOrchestrationEvent(run.id, 'started', { goal: 'demo' });

    const overview = getOrchestrationOverview(orch.workspace_id);
    expect(overview.members).toHaveLength(1);
    expect(overview.graph?.loops?.[0]?.max_iterations).toBe(2);
    expect(overview.active_run?.id).toBe(run.id);
    expect(overview.active_run?.events).toHaveLength(1);
    expect(listOrchestrationRuns(orch.workspace_id)).toHaveLength(1);
    expect(getActiveRunSummary(orch.workspace_id)?.status).toBe('running');
  });

  it('can disable orchestration via gateway setting', () => {
    expect(isMultiAgentOrchestrationEnabled()).toBe(true);
    setGatewaySetting(ORCHESTRATION_SETTING_KEY, 'false');
    expect(isMultiAgentOrchestrationEnabled()).toBe(false);
    setGatewaySetting(ORCHESTRATION_SETTING_KEY, 'true');
    expect(isMultiAgentOrchestrationEnabled()).toBe(true);
  });
});

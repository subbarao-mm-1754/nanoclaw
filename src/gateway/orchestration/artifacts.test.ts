import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initGatewayTestDb, closeGatewayDb, getGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import { createAgentRecord } from '../store/agents.js';
import {
  createOrchestrationArtifact,
  createOrchestrationRun,
  deleteOrchestrationForWorkspace,
  getAuthorizedOrchestrationArtifact,
  purgeExpiredOrchestrationArtifacts,
  replaceOrchestratorMembers,
  updateOrchestrationRun,
} from './store.js';

beforeEach(() => {
  initGatewayTestDb();
});

afterEach(() => {
  closeGatewayDb();
});

function agent(name: string, ownerId: string, kind: 'agent' | 'orchestrator' = 'agent') {
  return createAgentRecord({
    name,
    owner_user_id: ownerId,
    files: [{ path: 'CLAUDE.local.md', content: '# a' }],
    agent_kind: kind,
  });
}

describe('orchestration artifacts', () => {
  it('lets the owning orchestrator and its members read a result, and nobody else', () => {
    const owner = createUser({ email: 'owner@test.com', password: 'password123', display_name: 'Owner' });
    const other = createUser({ email: 'other@test.com', password: 'password123', display_name: 'Other' });
    const orch = agent('Planner', owner.id, 'orchestrator');
    const member = agent('Researcher', owner.id);
    const sameUserOutsider = agent('Unrelated', owner.id);
    const otherOrch = agent('Other planner', other.id, 'orchestrator');
    const otherMember = agent('Other researcher', other.id);
    replaceOrchestratorMembers(orch.workspace_id, [
      {
        member_workspace_id: member.workspace_id,
        member_agent_group_id: member.agent_group_id,
        local_name: 'researcher',
      },
    ]);
    replaceOrchestratorMembers(otherOrch.workspace_id, [
      {
        member_workspace_id: otherMember.workspace_id,
        member_agent_group_id: otherMember.agent_group_id,
        local_name: 'researcher',
      },
    ]);

    const run = createOrchestrationRun({ orchestrator_workspace_id: orch.workspace_id, goal: 'trip' });
    const body = `${'itinerary '.repeat(200)}Nishat Bagh day 2`;
    const artifact = createOrchestrationArtifact({
      runId: run.id,
      orchestratorWorkspaceId: orch.workspace_id,
      producerWorkspaceId: member.workspace_id,
      nodeId: 'research',
      content: body,
    });

    expect(getAuthorizedOrchestrationArtifact(artifact.id, orch.workspace_id)?.content_text).toBe(body);
    expect(getAuthorizedOrchestrationArtifact(artifact.id, member.workspace_id)?.content_text).toBe(body);
    expect(getAuthorizedOrchestrationArtifact(artifact.id, sameUserOutsider.workspace_id)).toBeNull();
    expect(getAuthorizedOrchestrationArtifact(artifact.id, otherOrch.workspace_id)).toBeNull();
    expect(getAuthorizedOrchestrationArtifact(artifact.id, otherMember.workspace_id)).toBeNull();
    expect(artifact.expires_at).toBeNull();
  });

  it('keeps artifacts while a run is active and expires them seven days after it finishes', () => {
    const owner = createUser({ email: 'life@test.com', password: 'password123', display_name: 'Life' });
    const orch = agent('Planner', owner.id, 'orchestrator');
    const run = createOrchestrationRun({ orchestrator_workspace_id: orch.workspace_id });
    const artifact = createOrchestrationArtifact({
      runId: run.id,
      orchestratorWorkspaceId: orch.workspace_id,
      nodeId: 'research',
      content: 'full result',
    });

    updateOrchestrationRun(run.id, { status: 'waiting' });
    expect(
      (getGatewayDb().prepare('SELECT expires_at FROM gateway_orchestration_artifacts WHERE id = ?').get(artifact.id) as {
        expires_at: string | null;
      }).expires_at,
    ).toBeNull();

    const before = Date.now();
    updateOrchestrationRun(run.id, { status: 'completed' });
    const row = getGatewayDb()
      .prepare('SELECT expires_at FROM gateway_orchestration_artifacts WHERE id = ?')
      .get(artifact.id) as { expires_at: string };
    const expiry = Date.parse(row.expires_at);
    expect(expiry).toBeGreaterThan(before + 6 * 24 * 60 * 60 * 1000);
    expect(expiry).toBeLessThan(before + 8 * 24 * 60 * 60 * 1000);
    expect(getAuthorizedOrchestrationArtifact(artifact.id, orch.workspace_id)?.content_text).toBe('full result');

    getGatewayDb()
      .prepare('UPDATE gateway_orchestration_artifacts SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', artifact.id);
    expect(purgeExpiredOrchestrationArtifacts()).toBe(1);
    expect(getAuthorizedOrchestrationArtifact(artifact.id, orch.workspace_id)).toBeNull();
  });

  it('deletes artifacts with the orchestrator run', () => {
    const owner = createUser({ email: 'del@test.com', password: 'password123', display_name: 'Del' });
    const orch = agent('Planner', owner.id, 'orchestrator');
    const run = createOrchestrationRun({ orchestrator_workspace_id: orch.workspace_id });
    createOrchestrationArtifact({
      runId: run.id,
      orchestratorWorkspaceId: orch.workspace_id,
      nodeId: 'research',
      content: 'gone',
    });
    deleteOrchestrationForWorkspace(orch.workspace_id);
    const left = getGatewayDb().prepare('SELECT COUNT(*) AS c FROM gateway_orchestration_artifacts').get() as {
      c: number;
    };
    expect(left.c).toBe(0);
  });
});

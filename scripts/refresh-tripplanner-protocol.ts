/**
 * Inject specialist/orchestrator reply-protocol appendix into TripPlanner agents.
 * Usage: pnpm exec tsx scripts/refresh-tripplanner-protocol.ts
 */
import { initGatewayDb, closeGatewayDb } from '../src/gateway/db/connection.js';
import { invalidateWorkerWorkspaceCache } from '../src/gateway/agent-service.js';
import {
  composeOrchestratorFiles,
  composeSpecialistFiles,
} from '../src/gateway/orchestration/compose.js';
import {
  getOrchestratorGraph,
  listOrchestratorMembers,
} from '../src/gateway/orchestration/store.js';
import { listAgentFiles, saveAgentFiles } from '../src/gateway/store/agent-files.js';
import { getWorkspace } from '../src/gateway/store/workspaces.js';

const TRIPPLANNER_WS = 'ws-cc7bc74c1c87f0ed';

function main(): void {
  initGatewayDb();
  try {
    const orch = getWorkspace(TRIPPLANNER_WS);
    if (!orch) throw new Error(`TripPlanner workspace not found: ${TRIPPLANNER_WS}`);

    const members = listOrchestratorMembers(TRIPPLANNER_WS);
    const graph = getOrchestratorGraph(TRIPPLANNER_WS);
    const specialistSpecs = members.map((m) => ({
      name: m.local_name,
      action: 'reuse' as const,
      role: m.role ?? undefined,
    }));

    // Orchestrator
    const orchFiles = composeOrchestratorFiles({
      files: listAgentFiles(TRIPPLANNER_WS),
      specialists: specialistSpecs,
      graph: graph ?? undefined,
    });
    saveAgentFiles(TRIPPLANNER_WS, orchFiles);
    invalidateWorkerWorkspaceCache(TRIPPLANNER_WS);
    console.log(`Updated orchestrator ${orch.name} (${TRIPPLANNER_WS})`);

    for (const m of members) {
      const ws = getWorkspace(m.member_workspace_id);
      if (!ws) {
        console.warn(`Skip missing member workspace ${m.member_workspace_id}`);
        continue;
      }
      const files = composeSpecialistFiles({
        files: listAgentFiles(m.member_workspace_id),
        localName: m.local_name,
        role: m.role,
      });
      saveAgentFiles(m.member_workspace_id, files);
      invalidateWorkerWorkspaceCache(m.member_workspace_id);
      console.log(`Updated specialist ${m.local_name} / ${ws.name} (${m.member_workspace_id})`);
    }

    console.log('Done. Next worker prepare will rewrite CLAUDE.local.md on disk.');
  } finally {
    closeGatewayDb();
  }
}

main();

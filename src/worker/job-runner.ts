import fs from 'fs';

import { WORKER_CLEANUP_WORKSPACE, WORKER_JOB_TIMEOUT_MS } from '../config.js';
import { wakeContainer, type WorkerSpawnContext } from '../container-runner.js';
import {
  ensureSessionWorkspace,
  inboundDbPath,
  outboundDbPath,
  writeSessionMessage,
  writeSessionRoutingFromJob,
} from '../session-manager.js';
import { log } from '../log.js';
import { captureMemoryBaseline, collectMemoryPatch } from './memory-sync.js';
import { collectOutboundMessages } from './outbound-collector.js';
import { materializeWorkspace } from './workspace-materializer.js';
import type { WorkerJobRequest, WorkerJobResponse } from './types.js';
import type { Session } from '../types.js';

function buildInboundContent(job: WorkerJobRequest): string {
  const content: Record<string, unknown> = { ...job.inbound.content };
  if (job.inbound.sender?.display_name) {
    content.sender = job.inbound.sender.display_name;
  }
  if (job.inbound.sender?.id) {
    content.senderId = job.inbound.sender.id;
  }
  return JSON.stringify(content);
}

function buildSession(job: WorkerJobRequest): Session {
  return {
    id: job.session.id,
    agent_group_id: job.session.agent_group_id,
    messaging_group_id: null,
    thread_id: job.delivery.thread_id,
    agent_provider: job.agent_snapshot.container_config.provider ?? null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function buildSpawnContext(job: WorkerJobRequest, workspace: ReturnType<typeof materializeWorkspace>): WorkerSpawnContext {
  return {
    agentGroup: {
      id: job.session.agent_group_id,
      name: job.agent_snapshot.name,
      folder: job.agent_snapshot.folder ?? job.session.agent_group_id,
      agent_provider: job.agent_snapshot.container_config.provider ?? null,
      created_at: new Date().toISOString(),
    },
    groupDir: workspace.groupDir,
    claudeSharedDir: workspace.claudeSharedDir,
    containerConfig: workspace.containerConfig,
  };
}

/**
 * Full worker job: materialize workspace, write inbound, spawn container,
 * collect outbound, return memory patch for the gateway to persist.
 */
export async function runWorkerJob(job: WorkerJobRequest): Promise<WorkerJobResponse> {
  const { agent_group_id: agentGroupId } = job.session;
  const sessionId = job.session.id;
  const runContainer = job.options?.run_container !== false;

  log.info('Worker job starting', { jobId: job.job_id, sessionId, agentGroupId, runContainer });

  const workspace = materializeWorkspace(job);
  const memoryBaseline = captureMemoryBaseline(
    workspace.groupDir,
    job.agent_snapshot.instructions ?? '',
    job.agent_snapshot.files,
  );

  ensureSessionWorkspace(agentGroupId, sessionId);
  writeSessionRoutingFromJob(agentGroupId, sessionId, job.delivery);

  writeSessionMessage(agentGroupId, sessionId, {
    id: job.inbound.id,
    kind: job.inbound.kind,
    timestamp: job.inbound.timestamp,
    platformId: job.delivery.platform_id,
    channelType: job.delivery.channel_type,
    threadId: job.delivery.thread_id,
    content: buildInboundContent(job),
    trigger: job.options?.trigger ?? 1,
  });

  const baseResponse: WorkerJobResponse = {
    job_id: job.job_id,
    status: 'prepared',
    session: { id: sessionId, agent_group_id: agentGroupId },
    workspace: {
      root: workspace.workspaceRoot,
      group_dir: workspace.groupDir,
      claude_shared_dir: workspace.claudeSharedDir,
    },
    session_paths: {
      inbound_db: inboundDbPath(agentGroupId, sessionId),
      outbound_db: outboundDbPath(agentGroupId, sessionId),
    },
    inbound_message_id: job.inbound.id,
  };

  if (!runContainer) {
    return {
      ...baseResponse,
      detail: 'Session prepared; run_container=false skipped container spawn.',
    };
  }

  const timeoutMs = job.options?.timeout_ms ?? WORKER_JOB_TIMEOUT_MS;
  const startedAt = Date.now();
  const session = buildSession(job);
  const spawnContext = buildSpawnContext(job, workspace);

  const spawned = await wakeContainer(session, spawnContext);
  if (!spawned) {
    return {
      ...baseResponse,
      status: 'failed',
      error: 'Container spawn failed (check Docker, image, and OneCLI gateway)',
    };
  }

  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  const outbound = await collectOutboundMessages({
    agentGroupId,
    sessionId,
    delivery: job.delivery,
    timeoutMs: remainingMs,
  });

  const memoryPatch = collectMemoryPatch(workspace.groupDir, memoryBaseline);

  if (WORKER_CLEANUP_WORKSPACE && fs.existsSync(workspace.workspaceRoot)) {
    fs.rmSync(workspace.workspaceRoot, { recursive: true, force: true });
    log.debug('Worker workspace cleaned up', { jobId: job.job_id });
  }

  const timedOut = outbound.length === 0 && Date.now() - startedAt >= timeoutMs;

  log.info('Worker job finished', {
    jobId: job.job_id,
    sessionId,
    outboundCount: outbound.length,
    timedOut,
  });

  return {
    ...baseResponse,
    status: timedOut ? 'timeout' : 'completed',
    outbound,
    memory_patch: memoryPatch,
    detail: timedOut
      ? 'Container ran but no outbound messages collected before timeout'
      : undefined,
  };
}

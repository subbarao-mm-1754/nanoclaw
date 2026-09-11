import fs from 'fs';

import {
  WORKER_BUILD_TURN_TIMEOUT_MS,
  WORKER_CLEANUP_WORKSPACE,
  WORKER_JOB_TIMEOUT_MS,
  WORKER_OUTBOUND_POST_STOP_GRACE_MS,
} from '../config.js';
import { wakeContainer, type WorkerSpawnContext } from '../container-runner.js';
import {
  ensureSessionWorkspace,
  inboundDbPath,
  outboundDbPath,
  writeSessionMessageIfAbsent,
  countPendingSessionInbound,
  writeSessionRoutingFromJob,
  writeDestinationsFromJob,
} from '../session-manager.js';
import { log } from '../log.js';
import { containerConfigFromSnapshot } from '../container-config.js';
import { captureMemoryBaseline, collectMemoryPatch } from './memory-sync.js';
import {
  collectOutboundMessages,
  drainOutboundBatch,
  startSessionCollector,
  stopSessionCollector,
  waitForInboundTurn,
} from './outbound-collector.js';
import { loadWorkspaceManifest, workerWorkspacePaths } from './workspace-store.js';
import type { WorkerProcessMessageRequest, WorkerProcessMessageResponse } from './types.js';
import type { Session } from '../types.js';
import { WorkerValidationError } from './validate.js';

function buildInboundContent(job: WorkerProcessMessageRequest): string {
  const content: Record<string, unknown> = { ...job.inbound.content };
  if (job.inbound.sender?.display_name) {
    content.sender = job.inbound.sender.display_name;
  }
  if (job.inbound.sender?.id) {
    content.senderId = job.inbound.sender.id;
  }

  // Chat messages render only content.text in the agent prompt. When the gateway
  // sends structured JSON (no text field), serialize the payload so the agent
  // sees it instead of an empty <message>.
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) {
    const payload: Record<string, unknown> = { ...content };
    delete payload.text;
    delete payload.sender;
    delete payload.senderId;
    if (Object.keys(payload).length > 0) {
      content.text = JSON.stringify(payload, null, 2);
    }
  }

  return JSON.stringify(content);
}

function buildSession(job: WorkerProcessMessageRequest, provider: string | null): Session {
  return {
    id: job.session.id,
    agent_group_id: job.session.agent_group_id,
    messaging_group_id: null,
    thread_id: job.delivery.thread_id,
    agent_provider: provider,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function buildSpawnContext(
  manifest: ReturnType<typeof loadWorkspaceManifest>,
  paths: ReturnType<typeof workerWorkspacePaths>,
): WorkerSpawnContext {
  const agentGroup = {
    id: manifest.agent_group_id,
    name: manifest.name,
    folder: manifest.folder,
    agent_provider: manifest.container_config.provider ?? null,
    created_at: manifest.created_at,
  };
  const containerConfig = containerConfigFromSnapshot(manifest.container_config, agentGroup);
  return {
    agentGroup,
    groupDir: paths.group_dir,
    claudeSharedDir: paths.claude_shared_dir,
    containerConfig,
    workspaceId: manifest.workspace_id,
  };
}

/** Async/builder jobs wait for processing_ack turn end (unless overridden). */
function shouldWaitForTurn(job: WorkerProcessMessageRequest): boolean {
  if (job.options?.wait_for_turn === true) return true;
  if (job.options?.wait_for_turn === false) return false;
  if (job.options?.wait_for_outbound === true) return false;
  return Boolean(job.options?.async || job.build_job_id);
}

/** Legacy one-shot: block until first outbound (explicit only, or non-turn async). */
function shouldWaitForOutbound(job: WorkerProcessMessageRequest): boolean {
  if (shouldWaitForTurn(job)) return false;
  if (job.options?.wait_for_outbound === true) return true;
  if (job.options?.wait_for_outbound === false) return false;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a message against a previously prepared workspace: write inbound,
 * spawn container.
 * - Normal channel traffic: continuous collector, return after wake.
 * - /build and /edit: continuous collector + wait for processing_ack turn end.
 * - Legacy wait_for_outbound: block until first outbound or timeout.
 */
export async function runProcessMessageJob(
  job: WorkerProcessMessageRequest,
): Promise<WorkerProcessMessageResponse> {
  const manifest = loadWorkspaceManifest(job.workspace_id);
  if (manifest.agent_group_id !== job.session.agent_group_id) {
    throw new WorkerValidationError(
      `session.agent_group_id (${job.session.agent_group_id}) does not match workspace manifest (${manifest.agent_group_id})`,
    );
  }

  const paths = workerWorkspacePaths(job.workspace_id);
  if (!fs.existsSync(paths.group_dir)) {
    throw new WorkerValidationError(`Workspace agent directory missing: ${job.workspace_id}`);
  }

  const { agent_group_id: agentGroupId } = job.session;
  const sessionId = job.session.id;
  const runContainer = job.options?.run_container !== false;
  const waitForTurn = shouldWaitForTurn(job);
  const waitForOutbound = shouldWaitForOutbound(job);

  log.info('Worker process-message starting', {
    jobId: job.job_id,
    workspaceId: job.workspace_id,
    sessionId,
    agentGroupId,
    runContainer,
    waitForTurn,
    waitForOutbound,
    buildJobId: job.build_job_id,
  });

  const memoryBaseline = captureMemoryBaseline(paths.group_dir);

  ensureSessionWorkspace(agentGroupId, sessionId);
  writeSessionRoutingFromJob(agentGroupId, sessionId, job.delivery);
  writeDestinationsFromJob(agentGroupId, sessionId, {
    ...job.delivery,
    display_name: job.delivery.display_name ?? job.inbound.sender?.display_name,
  });

  const wroteInbound = writeSessionMessageIfAbsent(agentGroupId, sessionId, {
    id: job.inbound.id,
    kind: job.inbound.kind,
    timestamp: job.inbound.timestamp,
    platformId: job.delivery.platform_id,
    channelType: job.delivery.channel_type,
    threadId: job.delivery.thread_id,
    content: buildInboundContent(job),
    trigger: job.options?.trigger ?? 1,
  });

  const baseResponse: WorkerProcessMessageResponse = {
    job_id: job.job_id,
    build_job_id: job.build_job_id,
    status: 'prepared',
    workspace_id: job.workspace_id,
    session: { id: sessionId, agent_group_id: agentGroupId },
    workspace: {
      root: paths.root,
      group_dir: paths.group_dir,
      claude_shared_dir: paths.claude_shared_dir,
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

  if (!wroteInbound && countPendingSessionInbound(agentGroupId, sessionId) === 0) {
    log.info('Worker skipping duplicate inbound (session already processed)', {
      jobId: job.job_id,
      inboundMessageId: job.inbound.id,
      sessionId,
    });
    return {
      ...baseResponse,
      status: 'completed',
      outbound: [],
      detail: 'Duplicate platform message; session already has no pending inbound.',
    };
  }

  const turnTimeoutMs =
    job.options?.timeout_ms ??
    (waitForTurn ? WORKER_BUILD_TURN_TIMEOUT_MS : WORKER_JOB_TIMEOUT_MS);
  const startedAt = Date.now();
  const provider = manifest.container_config.provider ?? null;
  const session = buildSession(job, provider);
  const spawnContext = buildSpawnContext(manifest, paths);

  // Continuous collector for channel traffic and builder/edit turns.
  if (!waitForOutbound) {
    startSessionCollector({
      workspaceId: job.workspace_id,
      agentGroupId,
      sessionId,
      delivery: job.delivery,
      conversationId: job.conversation_id,
      jobId: job.job_id,
      buildJobId: job.build_job_id,
      groupDir: paths.group_dir,
    });
  }

  const spawnStartedAt = Date.now();
  const spawned = await wakeContainer(session, spawnContext);
  const spawnMs = Date.now() - spawnStartedAt;
  if (!spawned) {
    if (!waitForOutbound) {
      stopSessionCollector(sessionId, 'spawn-failed');
    }
    log.warn('Worker process-message spawn failed', {
      jobId: job.job_id,
      sessionId,
      spawnMs,
    });
    return {
      ...baseResponse,
      status: 'failed',
      error: 'Container spawn failed (check Docker, image, and OneCLI gateway)',
    };
  }
  log.info('Worker container ready', { jobId: job.job_id, sessionId, spawnMs });

  if (!waitForOutbound && !waitForTurn) {
    return {
      ...baseResponse,
      status: 'completed',
      outbound: [],
      detail: 'Container woken; outbound will be delivered by session collector',
    };
  }

  if (waitForTurn) {
    const remainingMs = Math.max(0, turnTimeoutMs - (Date.now() - startedAt));
    const turnStartedAt = Date.now();
    const turnResult = await waitForInboundTurn({
      agentGroupId,
      sessionId,
      inboundMessageId: job.inbound.id,
      timeoutMs: remainingMs,
    });
    // Let the continuous collector push any late chat rows before we drain leftovers.
    await sleep(WORKER_OUTBOUND_POST_STOP_GRACE_MS);
    const leftover = await drainOutboundBatch(
      job.workspace_id,
      agentGroupId,
      sessionId,
      job.delivery,
    );
    const memoryPatch = collectMemoryPatch(paths.group_dir, memoryBaseline);
    const turnMs = Date.now() - turnStartedAt;
    const elapsedMs = Date.now() - startedAt;

    let status: WorkerProcessMessageResponse['status'] = 'completed';
    let detail: string | undefined;
    let error: string | undefined;
    if (turnResult === 'completed') {
      status = 'completed';
    } else if (turnResult === 'timeout') {
      status = 'timeout';
      detail =
        'Builder turn did not finish before timeout (agent still processing — raise WORKER_BUILD_TURN_TIMEOUT_MS if needed)';
    } else if (turnResult === 'failed') {
      status = 'failed';
      error = 'Builder turn failed inside the container';
    } else {
      status = 'failed';
      error = 'Builder container stopped before the turn completed';
    }

    log.info('Worker process-message turn finished', {
      jobId: job.job_id,
      workspaceId: job.workspace_id,
      sessionId,
      turnResult,
      leftoverCount: leftover.length,
      spawnMs,
      turnMs,
      elapsedMs,
    });

    return {
      ...baseResponse,
      status,
      outbound: leftover,
      memory_patch: memoryPatch,
      detail,
      error,
    };
  }

  // Legacy one-shot outbound wait.
  const timeoutMs = turnTimeoutMs;
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  const collectStartedAt = Date.now();
  const outbound = await collectOutboundMessages({
    workspaceId: job.workspace_id,
    agentGroupId,
    sessionId,
    delivery: job.delivery,
    timeoutMs: remainingMs,
  });
  const collectMs = Date.now() - collectStartedAt;

  const memoryPatch = collectMemoryPatch(paths.group_dir, memoryBaseline);

  if (WORKER_CLEANUP_WORKSPACE && fs.existsSync(paths.root)) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    log.debug('Worker workspace cleaned up', { workspaceId: job.workspace_id });
  }

  const elapsedMs = Date.now() - startedAt;
  const timedOut = outbound.length === 0 && elapsedMs >= timeoutMs;

  log.info('Worker process-message finished', {
    jobId: job.job_id,
    workspaceId: job.workspace_id,
    sessionId,
    outboundCount: outbound.length,
    timedOut,
    spawnMs,
    collectMs,
    elapsedMs,
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

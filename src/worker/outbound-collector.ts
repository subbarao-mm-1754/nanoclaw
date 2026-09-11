import {
  GATEWAY_PUBLIC_URL,
  WORKER_AUTH_TOKEN,
  WORKER_OUTBOUND_COLLECT_POLL_MS,
  WORKER_OUTBOUND_POST_STOP_GRACE_MS,
} from '../config.js';
import {
  getDeliveredIds,
  getDueOutboundMessages,
  markDelivered,
  migrateDeliveredTable,
} from '../db/session-db.js';
import { log } from '../log.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from '../session-manager.js';
import { isContainerRunning, onContainerExit } from '../container-runner.js';
import { captureMemoryBaseline, collectMemoryPatch } from './memory-sync.js';
import { workerWorkspacePaths } from './workspace-store.js';
import type {
  WorkerCollectedOutbound,
  WorkerDelivery,
  WorkerMemoryPatch,
  WorkerOutboundCallbackPayload,
} from './types.js';
import { handleKnowledgeSystemMessage } from './knowledge-actions.js';
import { handleBrowserSessionSystemMessage } from './browser-session-actions.js';

const POST_STOP_GRACE_MS = WORKER_OUTBOUND_POST_STOP_GRACE_MS;
const POLL_MS = WORKER_OUTBOUND_COLLECT_POLL_MS;

export interface SessionCollectorTarget {
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  delivery: WorkerDelivery;
  conversationId?: string;
  jobId?: string;
  /** Gateway build/edit job — continuous chat is delivered via builder path. */
  buildJobId?: string;
  /** When set, collector captures memory patch on stop. */
  groupDir?: string;
}

interface ActiveCollector extends SessionCollectorTarget {
  memoryBaseline: ReturnType<typeof captureMemoryBaseline> | null;
  inflight: boolean;
  emptyPolls: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeExit: (() => void) | null;
  stopping: boolean;
}

const collectors = new Map<string, ActiveCollector>();
const inflightSessions = new Set<string>();
let loopTimer: ReturnType<typeof setInterval> | null = null;

function matchesDelivery(
  msg: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
  delivery: WorkerDelivery,
): boolean {
  if (msg.channel_type !== delivery.channel_type) return false;
  if (msg.platform_id !== delivery.platform_id) return false;
  if (delivery.thread_id !== null && msg.thread_id !== delivery.thread_id) return false;
  return true;
}

/** Notify target for system actions when the collector drains with delivery=null. */
function resolveSystemNotifyDelivery(
  delivery: WorkerDelivery | null,
  inDb: ReturnType<typeof openInboundDb>,
): WorkerDelivery | null {
  if (delivery?.channel_type && delivery.platform_id) return delivery;
  const row = inDb
    .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
    .get() as
    | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
    | undefined;
  if (row?.channel_type && row.platform_id) {
    return {
      channel_type: row.channel_type,
      platform_id: row.platform_id,
      thread_id: row.thread_id,
    };
  }
  return null;
}

function encodeFiles(files: Array<{ filename: string; data: Buffer }>): WorkerCollectedOutbound['files'] {
  return files.map((f) => ({
    filename: f.filename,
    data_base64: f.data.toString('base64'),
  }));
}

/**
 * Drain due outbound rows for a session.
 * - System / agent rows handled locally and marked delivered.
 * - Chat rows matching `delivery` (when provided) are returned and marked delivered.
 * - When `delivery` is null, any chat row with channel_type + platform_id is returned.
 */
export async function drainOutboundBatch(
  workspaceId: string,
  agentGroupId: string,
  sessionId: string,
  delivery: WorkerDelivery | null,
  skipIds: Set<string> = new Set(),
): Promise<WorkerCollectedOutbound[]> {
  const results: WorkerCollectedOutbound[] = [];
  let outDb;
  let inDb;
  try {
    outDb = openOutboundDb(agentGroupId, sessionId);
    inDb = openInboundDb(agentGroupId, sessionId);
  } catch {
    return results;
  }

  try {
    migrateDeliveredTable(inDb);
    const delivered = getDeliveredIds(inDb);
    const due = getDueOutboundMessages(outDb).filter((m) => !delivered.has(m.id) && !skipIds.has(m.id));

    for (const msg of due) {
      if (msg.kind === 'system' || msg.channel_type === 'agent') {
        if (msg.kind === 'system') {
          try {
            // Session collector drains with delivery=null so all chat destinations
            // are pushed; browser-session notify still needs a channel target —
            // fall back to session_routing written at job start.
            const notifyDelivery = resolveSystemNotifyDelivery(delivery, inDb);
            const handledBrowser = await handleBrowserSessionSystemMessage({
              workspaceId,
              agentGroupId,
              sessionId,
              delivery: notifyDelivery,
              rawContent: msg.content,
            });
            if (!handledBrowser) {
              await handleKnowledgeSystemMessage({
                workspaceId,
                agentGroupId,
                sessionId,
                rawContent: msg.content,
              });
            }
          } catch (err) {
            log.error('Failed handling system action', { sessionId, msgId: msg.id, err });
          }
        }
        markDelivered(inDb, msg.id, null);
        continue;
      }

      if (delivery) {
        if (!matchesDelivery(msg, delivery)) continue;
      } else if (!msg.channel_type || !msg.platform_id) {
        continue;
      }

      let content: Record<string, unknown>;
      try {
        content = JSON.parse(msg.content) as Record<string, unknown>;
      } catch {
        content = { raw: msg.content };
      }

      const declaredFiles = Array.isArray(content.files) ? (content.files as string[]) : [];
      const fileBuffers = declaredFiles.length
        ? readOutboxFiles(agentGroupId, sessionId, msg.id, declaredFiles)
        : undefined;

      results.push({
        id: msg.id,
        kind: msg.kind,
        channel_type: msg.channel_type,
        platform_id: msg.platform_id,
        thread_id: msg.thread_id,
        content,
        files: fileBuffers ? encodeFiles(fileBuffers) : undefined,
      });

      markDelivered(inDb, msg.id, null);
      if (declaredFiles.length > 0) {
        clearOutbox(agentGroupId, sessionId, msg.id);
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }

  return results;
}

export interface CollectOutboundOptions {
  workspaceId: string;
  agentGroupId: string;
  sessionId: string;
  delivery: WorkerDelivery;
  timeoutMs: number;
}

/**
 * One-shot wait used by async/builder jobs: poll until a matching chat outbound
 * appears, the container exits, or timeoutMs elapses.
 * Prefer startSessionCollector for normal channel traffic.
 */
export async function collectOutboundMessages(opts: CollectOutboundOptions): Promise<WorkerCollectedOutbound[]> {
  const { workspaceId, agentGroupId, sessionId, delivery, timeoutMs } = opts;
  const collected: WorkerCollectedOutbound[] = [];
  const collectedIds = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let containerStoppedAt: number | null = null;

  while (Date.now() < deadline) {
    const batch = await drainOutboundBatch(workspaceId, agentGroupId, sessionId, delivery, collectedIds);
    for (const msg of batch) {
      collected.push(msg);
      collectedIds.add(msg.id);
    }

    if (collected.length > 0) break;

    if (!isContainerRunning(sessionId)) {
      if (containerStoppedAt === null) {
        containerStoppedAt = Date.now();
      } else if (Date.now() - containerStoppedAt >= POST_STOP_GRACE_MS) {
        break;
      }
    } else {
      containerStoppedAt = null;
    }

    await sleep(POLL_MS);
  }

  if (collected.length === 0) {
    const tail = await drainOutboundBatch(workspaceId, agentGroupId, sessionId, delivery, collectedIds);
    collected.push(...tail);
  }

  log.info('Worker outbound collection finished', {
    sessionId,
    count: collected.length,
    timedOut: Date.now() >= deadline,
  });

  return collected;
}

async function postOutboundToGateway(payload: WorkerOutboundCallbackPayload): Promise<void> {
  const url = `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/worker/callbacks/outbound`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_AUTH_TOKEN) headers.Authorization = `Bearer ${WORKER_AUTH_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Outbound callback HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function pushCollected(collector: ActiveCollector, outbound: WorkerCollectedOutbound[]): Promise<void> {
  if (outbound.length === 0) return;
  await postOutboundToGateway({
    workspace_id: collector.workspaceId,
    session_id: collector.sessionId,
    agent_group_id: collector.agentGroupId,
    conversation_id: collector.conversationId,
    job_id: collector.jobId,
    build_job_id: collector.buildJobId,
    outbound,
  });
  log.info('Worker outbound collector delivered batch', {
    sessionId: collector.sessionId,
    count: outbound.length,
    buildJobId: collector.buildJobId,
  });
}

async function tickCollector(collector: ActiveCollector): Promise<void> {
  if (collector.inflight || collector.stopping) return;
  if (inflightSessions.has(collector.sessionId)) return;

  collector.inflight = true;
  inflightSessions.add(collector.sessionId);
  try {
    const batch = await drainOutboundBatch(
      collector.workspaceId,
      collector.agentGroupId,
      collector.sessionId,
      null, // deliver all addressed chat rows for this session
    );
    if (batch.length > 0) {
      collector.emptyPolls = 0;
      try {
        await pushCollected(collector, batch);
      } catch (err) {
        log.error('Worker outbound collector gateway push failed', {
          sessionId: collector.sessionId,
          err,
        });
      }
    } else {
      collector.emptyPolls += 1;
    }
  } finally {
    collector.inflight = false;
    inflightSessions.delete(collector.sessionId);
  }
}

async function tickAllCollectors(): Promise<void> {
  const active = [...collectors.values()];
  if (active.length === 0) return;
  await Promise.all(active.map((c) => tickCollector(c)));
}

function ensureLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    void tickAllCollectors();
  }, POLL_MS);
  // Unref so the timer alone doesn't keep the process alive in tests.
  if (typeof loopTimer === 'object' && 'unref' in loopTimer) {
    loopTimer.unref();
  }
}

function stopLoopIfIdle(): void {
  if (collectors.size > 0 || !loopTimer) return;
  clearInterval(loopTimer);
  loopTimer = null;
}

function buildMemoryPatch(collector: ActiveCollector): WorkerMemoryPatch | undefined {
  if (!collector.groupDir || !collector.memoryBaseline) return undefined;
  return collectMemoryPatch(collector.groupDir, collector.memoryBaseline) ?? undefined;
}

async function finalizeCollector(sessionId: string, reason: string): Promise<void> {
  const collector = collectors.get(sessionId);
  if (!collector || collector.stopping) return;
  collector.stopping = true;

  if (collector.stopTimer) {
    clearTimeout(collector.stopTimer);
    collector.stopTimer = null;
  }
  if (collector.unsubscribeExit) {
    collector.unsubscribeExit();
    collector.unsubscribeExit = null;
  }

  // Final drain after grace for late writes.
  await sleep(POST_STOP_GRACE_MS);
  try {
    const batch = await drainOutboundBatch(
      collector.workspaceId,
      collector.agentGroupId,
      collector.sessionId,
      null,
    );
    const memoryPatch = buildMemoryPatch(collector);
    if (batch.length > 0 || memoryPatch) {
      await postOutboundToGateway({
        workspace_id: collector.workspaceId,
        session_id: collector.sessionId,
        agent_group_id: collector.agentGroupId,
        conversation_id: collector.conversationId,
        job_id: collector.jobId,
        build_job_id: collector.buildJobId,
        outbound: batch,
        memory_patch: memoryPatch,
      });
    }
  } catch (err) {
    log.error('Worker outbound collector finalize failed', { sessionId, reason, err });
  }

  collectors.delete(sessionId);
  stopLoopIfIdle();
  log.info('Worker outbound collector stopped', { sessionId, reason });
}

/**
 * Start (or refresh) a continuous outbound collector for a session.
 * Runs until the container exits / is removed, or stopSessionCollector is called
 * (workspace destroy / agent delete).
 */
export function startSessionCollector(target: SessionCollectorTarget): void {
  const existing = collectors.get(target.sessionId);
  if (existing) {
    existing.delivery = target.delivery;
    existing.conversationId = target.conversationId ?? existing.conversationId;
    existing.jobId = target.jobId ?? existing.jobId;
    existing.buildJobId = target.buildJobId ?? existing.buildJobId;
    existing.workspaceId = target.workspaceId;
    existing.agentGroupId = target.agentGroupId;
    if (target.groupDir && !existing.memoryBaseline) {
      existing.groupDir = target.groupDir;
      existing.memoryBaseline = captureMemoryBaseline(target.groupDir);
    }
    // Cancel a pending stop if the container was re-woken.
    if (existing.stopTimer) {
      clearTimeout(existing.stopTimer);
      existing.stopTimer = null;
      existing.stopping = false;
    }
    return;
  }

  const paths = target.groupDir
    ? null
    : (() => {
        try {
          return workerWorkspacePaths(target.workspaceId);
        } catch {
          return null;
        }
      })();
  const groupDir = target.groupDir ?? paths?.group_dir;

  const collector: ActiveCollector = {
    ...target,
    groupDir,
    memoryBaseline: groupDir ? captureMemoryBaseline(groupDir) : null,
    inflight: false,
    emptyPolls: 0,
    stopTimer: null,
    unsubscribeExit: null,
    stopping: false,
  };

  collector.unsubscribeExit = onContainerExit(target.sessionId, () => {
    const current = collectors.get(target.sessionId);
    if (!current || current.stopping) return;
    // Debounce: container may restart quickly on wake; only finalize after grace
    // if still not running.
    if (current.stopTimer) clearTimeout(current.stopTimer);
    current.stopTimer = setTimeout(() => {
      current.stopTimer = null;
      if (isContainerRunning(target.sessionId)) return;
      void finalizeCollector(target.sessionId, 'container-stopped');
    }, POST_STOP_GRACE_MS);
  });

  collectors.set(target.sessionId, collector);
  ensureLoop();
  log.info('Worker outbound collector started', {
    sessionId: target.sessionId,
    workspaceId: target.workspaceId,
  });
  void tickCollector(collector);
}

/** Stop collector for one session (container removed / explicit). */
export function stopSessionCollector(sessionId: string, reason = 'explicit'): void {
  const collector = collectors.get(sessionId);
  if (!collector) return;
  void finalizeCollector(sessionId, reason);
}

/** Stop all collectors for a workspace (agent delete / workspace destroy). */
export function stopCollectorsForWorkspace(workspaceId: string, reason = 'workspace-destroyed'): void {
  for (const [sessionId, collector] of collectors) {
    if (collector.workspaceId === workspaceId) {
      void finalizeCollector(sessionId, reason);
    }
  }
}

export function getActiveCollectorSessionIds(): string[] {
  return [...collectors.keys()];
}

/** @internal Test helper */
export function stopAllCollectorsForTests(): void {
  for (const sessionId of [...collectors.keys()]) {
    const c = collectors.get(sessionId);
    if (c?.unsubscribeExit) c.unsubscribeExit();
    if (c?.stopTimer) clearTimeout(c.stopTimer);
    collectors.delete(sessionId);
  }
  stopLoopIfIdle();
}

export function startOutboundCollectorRuntime(): void {
  ensureLoop();
  log.info('Worker outbound collector runtime ready', { pollMs: POLL_MS });
}

export function stopOutboundCollectorRuntime(): void {
  for (const sessionId of [...collectors.keys()]) {
    stopSessionCollector(sessionId, 'worker-shutdown');
  }
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

export type InboundTurnWaitResult = 'completed' | 'failed' | 'timeout' | 'container-stopped';

function readProcessingAckStatus(
  agentGroupId: string,
  sessionId: string,
  inboundMessageId: string,
): string | null {
  try {
    const outDb = openOutboundDb(agentGroupId, sessionId);
    try {
      const row = outDb
        .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
        .get(inboundMessageId) as { status: string } | undefined;
      return row?.status ?? null;
    } finally {
      outDb.close();
    }
  } catch {
    return null;
  }
}

/**
 * Block until the container marks `inboundMessageId` completed/failed in
 * processing_ack, the container stops, or timeoutMs elapses.
 * Used by /build and /edit so turn completion is event-driven while outbound
 * streams via the continuous collector.
 */
export async function waitForInboundTurn(opts: {
  agentGroupId: string;
  sessionId: string;
  inboundMessageId: string;
  timeoutMs: number;
}): Promise<InboundTurnWaitResult> {
  const { agentGroupId, sessionId, inboundMessageId, timeoutMs } = opts;
  const deadline = Date.now() + timeoutMs;
  let containerStoppedAt: number | null = null;

  while (Date.now() < deadline) {
    const status = readProcessingAckStatus(agentGroupId, sessionId, inboundMessageId);
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';

    if (!isContainerRunning(sessionId)) {
      if (containerStoppedAt === null) {
        containerStoppedAt = Date.now();
      } else if (Date.now() - containerStoppedAt >= POST_STOP_GRACE_MS) {
        const after = readProcessingAckStatus(agentGroupId, sessionId, inboundMessageId);
        if (after === 'completed') return 'completed';
        if (after === 'failed') return 'failed';
        return 'container-stopped';
      }
    } else {
      containerStoppedAt = null;
    }

    await sleep(POLL_MS);
  }

  const finalStatus = readProcessingAckStatus(agentGroupId, sessionId, inboundMessageId);
  if (finalStatus === 'completed') return 'completed';
  if (finalStatus === 'failed') return 'failed';
  return 'timeout';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

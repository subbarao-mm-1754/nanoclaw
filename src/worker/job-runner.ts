import {
  ensureSessionWorkspace,
  inboundDbPath,
  outboundDbPath,
  writeSessionMessage,
  writeSessionRoutingFromJob,
} from '../session-manager.js';
import { log } from '../log.js';
import { materializeWorkspace } from './workspace-materializer.js';
import type { WorkerJobRequest, WorkerJobResponse } from './types.js';

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

/**
 * Phases A–C: materialize workspace, init session DBs, write routing + inbound.
 * Container spawn and outbound collection are Phase D.
 */
export function runWorkerJob(job: WorkerJobRequest): WorkerJobResponse {
  const { agent_group_id: agentGroupId } = job.session;
  const sessionId = job.session.id;

  log.info('Worker job starting', { jobId: job.job_id, sessionId, agentGroupId });

  const workspace = materializeWorkspace(job);

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

  log.info('Worker job prepared', {
    jobId: job.job_id,
    sessionId,
    inboundMessageId: job.inbound.id,
  });

  return {
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
    detail: 'Message written to inbound.db; container spawn is Phase D.',
  };
}

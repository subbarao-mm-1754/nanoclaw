import { getChannelAdapter } from '../../channels/channel-registry.js';
import { generateId } from '../auth.js';
import { createAgent } from '../agent-service.js';
import { log } from '../../log.js';
import { defaultContainerConfig } from '../store/agent-files.js';
import {
  createBuildJob,
  createBuildRun,
  getActiveBuildJobForUser,
  getBuildJobDetail,
  getBuildJobForUser,
  getBuildRun,
  insertBuildMessage,
  listBuildJobsForUser,
  updateBuildJobStatus,
  updateBuildRun,
} from '../store/builds.js';
import { getWorkspace, registerWorkspace } from '../store/workspaces.js';
import type {
  BuildJob,
  BuildJobDetail,
  BuildMessage,
  BuildRun,
  GatewayAgent,
  GatewayUser,
} from '../types.js';
import {
  destroyWorkspaceOnWorker,
  enqueueProcessMessageOnWorker,
  prepareWorkspaceOnWorker,
} from '../worker-client.js';
import type { WorkerProcessMessageResponse } from '../../worker/types.js';
import { builderAgentFiles } from './prompt.js';
import { parseBuildResultFromOutbound, stripBuildFence } from './parse-result.js';

const BUILDER_NAME = 'Agent Builder';

export type BuildDelivery = {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
};

function builderWorkspaceId(userId: string): string {
  return `ws-builder-${userId}`;
}

function builderAgentGroupId(userId: string): string {
  return `ag-builder-${userId}`;
}

function builderSessionId(jobId: string): string {
  return `sess-build-${jobId}`;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'BuildError';
  }
}

export async function ensureBuilderWorkspace(user: GatewayUser): Promise<{
  workspace_id: string;
  agent_group_id: string;
}> {
  const workspaceId = builderWorkspaceId(user.id);
  const agentGroupId = builderAgentGroupId(user.id);
  const files = builderAgentFiles();
  const containerConfig = defaultContainerConfig(BUILDER_NAME);

  await prepareWorkspaceOnWorker({
    workspace_id: workspaceId,
    agent: {
      agent_group_id: agentGroupId,
      name: BUILDER_NAME,
      folder: `builder-${user.id}`,
      container_config: containerConfig,
      cli_scope: 'group',
      files,
    },
    options: { replace: true },
  });

  if (!getWorkspace(workspaceId)) {
    registerWorkspace({
      workspace_id: workspaceId,
      agent_group_id: agentGroupId,
      name: BUILDER_NAME,
      owner_user_id: user.id,
      folder: `builder-${user.id}`,
      cli_scope: 'group',
      container_config: containerConfig,
      is_default: false,
    });
  }

  return { workspace_id: workspaceId, agent_group_id: agentGroupId };
}

function deliveryForJob(job: BuildJob, user: GatewayUser): BuildDelivery {
  if (job.delivery_channel_type && job.delivery_platform_id) {
    return {
      channel_type: job.delivery_channel_type,
      platform_id: job.delivery_platform_id,
      thread_id: job.delivery_thread_id,
    };
  }
  return {
    channel_type: 'http',
    platform_id: user.id,
    thread_id: job.id,
  };
}

async function deliverBuildText(job: BuildJob, text: string): Promise<void> {
  if (!job.delivery_channel_type || !job.delivery_platform_id) return;
  const adapter = getChannelAdapter(job.delivery_channel_type);
  if (!adapter) {
    log.warn('No adapter to deliver builder reply', {
      jobId: job.id,
      channelType: job.delivery_channel_type,
    });
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  try {
    await adapter.deliver(job.delivery_platform_id, job.delivery_thread_id, {
      kind: 'chat',
      content: { text: trimmed },
    });
  } catch (err) {
    log.error('Failed to deliver builder reply to channel', {
      jobId: job.id,
      channelType: job.delivery_channel_type,
      err,
    });
  }
}

async function startRun(job: BuildJob, inboundMessage: BuildMessage, user: GatewayUser): Promise<BuildRun> {
  const runId = generateId('run');
  createBuildRun({ id: runId, job_id: job.id });
  updateBuildJobStatus(job.id, 'in_progress');

  const text =
    typeof inboundMessage.content.text === 'string'
      ? inboundMessage.content.text
      : JSON.stringify(inboundMessage.content);
  const delivery = deliveryForJob(job, user);

  try {
    await enqueueProcessMessageOnWorker(
      {
        job_id: runId,
        build_job_id: job.id,
        workspace_id: job.builder_workspace_id,
        session: {
          id: job.builder_session_id,
          agent_group_id: job.builder_agent_group_id,
        },
        delivery: {
          channel_type: delivery.channel_type,
          platform_id: delivery.platform_id,
          thread_id: delivery.thread_id,
          name: 'client',
          display_name: user.display_name,
        },
        inbound: {
          id: inboundMessage.id,
          kind: 'chat',
          timestamp: inboundMessage.created_at,
          content: { text },
          sender: { id: user.id, display_name: user.display_name },
        },
      },
      job.id,
    );
    updateBuildRun(runId, 'running');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateBuildRun(runId, 'failed', { error: message });
    updateBuildJobStatus(job.id, 'failed', { error: message });
    throw err;
  }

  return getBuildRun(runId)!;
}

export async function startBuild(
  user: GatewayUser,
  input: {
    message: string;
    title?: string;
    delivery?: BuildDelivery;
  },
): Promise<BuildJobDetail> {
  const text = input.message.trim();
  if (!text) throw new BuildError('message is required');

  const active = getActiveBuildJobForUser(user.id);
  if (active) {
    throw new BuildError(
      `An active build already exists (${active.id}). Continue it or wait until it finishes.`,
      409,
    );
  }

  const builder = await ensureBuilderWorkspace(user);
  const jobId = generateId('job');
  const job = createBuildJob({
    id: jobId,
    user_id: user.id,
    title: input.title?.trim() || text.slice(0, 80),
    builder_workspace_id: builder.workspace_id,
    builder_agent_group_id: builder.agent_group_id,
    builder_session_id: builderSessionId(jobId),
    delivery_channel_type: input.delivery?.channel_type ?? null,
    delivery_platform_id: input.delivery?.platform_id ?? null,
    delivery_thread_id: input.delivery?.thread_id ?? null,
  });

  const message = insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'inbound',
    role: 'user',
    content: { text },
  });

  await startRun(job, message, user);
  return getBuildJobDetail(job.id)!;
}

export async function continueBuild(
  user: GatewayUser,
  jobId: string,
  input: { message: string },
): Promise<BuildJobDetail> {
  const text = input.message.trim();
  if (!text) throw new BuildError('message is required');

  const job = getBuildJobForUser(jobId, user.id);
  if (!job) throw new BuildError('Build job not found', 404);

  if (job.status === 'completed' || job.status === 'failed') {
    throw new BuildError(`Build job is already ${job.status}`, 409);
  }

  if (job.status === 'in_progress') {
    throw new BuildError(
      'Builder is still processing the previous turn. Wait until status is waiting_for_user.',
      409,
    );
  }

  const message = insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'inbound',
    role: 'user',
    content: { text },
  });

  await startRun(job, message, user);
  return getBuildJobDetail(job.id)!;
}

export async function cancelBuild(user: GatewayUser, jobId?: string): Promise<BuildJobDetail> {
  const job = jobId ? getBuildJobForUser(jobId, user.id) : getActiveBuildJobForUser(user.id);
  if (!job) throw new BuildError('No active build to cancel', 404);
  if (job.status === 'completed' || job.status === 'failed') {
    throw new BuildError(`Build job is already ${job.status}`, 409);
  }

  updateBuildJobStatus(job.id, 'failed', { error: 'Cancelled by user' });
  insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'outbound',
    role: 'system',
    content: { text: 'Build cancelled.' },
  });
  await cleanupBuilder(job);
  await deliverBuildText(job, 'Build cancelled. You can start a new one with `/build …`.');
  return getBuildJobDetail(job.id)!;
}

export function getBuild(user: GatewayUser, jobId: string): BuildJobDetail {
  const job = getBuildJobForUser(jobId, user.id);
  if (!job) throw new BuildError('Build job not found', 404);
  return getBuildJobDetail(job.id)!;
}

export function listBuilds(user: GatewayUser, limit = 20): BuildJob[] {
  return listBuildJobsForUser(user.id, limit);
}

async function cleanupBuilder(job: BuildJob): Promise<void> {
  try {
    await destroyWorkspaceOnWorker({
      workspace_id: job.builder_workspace_id,
      session_id: job.builder_session_id,
    });
  } catch (err) {
    log.warn('Failed to destroy builder workspace after build', {
      jobId: job.id,
      workspaceId: job.builder_workspace_id,
      err,
    });
  }
}

async function finalizeCompletedBuild(
  job: BuildJob,
  parsed: NonNullable<ReturnType<typeof parseBuildResultFromOutbound>>,
): Promise<GatewayAgent | null> {
  if (!parsed.files || parsed.files.length === 0) {
    updateBuildJobStatus(job.id, 'failed', {
      error: 'Builder marked completed but returned no agent files',
    });
    await deliverBuildText(job, 'Build failed: no agent files were produced.');
    await cleanupBuilder(job);
    return null;
  }

  const agentName = parsed.agent_name?.trim() || job.title || 'New Agent';
  const agent = await createAgent({
    name: agentName,
    owner_user_id: job.user_id,
    files: parsed.files,
    is_default: false,
  });

  updateBuildJobStatus(job.id, 'completed', {
    result_workspace_id: agent.workspace_id,
    result_agent_group_id: agent.agent_group_id,
    title: agentName,
  });

  const doneText = `Agent "${agentName}" created. Further messages in this chat go to your agents (not the builder). Start another with \`/build …\`.`;
  insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'outbound',
    role: 'system',
    content: {
      text: doneText,
      agent_workspace_id: agent.workspace_id,
    },
  });

  await deliverBuildText(job, doneText);
  await cleanupBuilder(job);
  return agent;
}

/**
 * Worker → Gateway callback for one builder run (turn).
 */
export async function handleBuilderRunCallback(
  result: WorkerProcessMessageResponse,
): Promise<void> {
  const runId = result.job_id;
  const run = getBuildRun(runId);
  if (!run) {
    log.warn('Builder callback for unknown run', { runId, buildJobId: result.build_job_id });
    return;
  }

  const detail = getBuildJobDetail(run.job_id);
  if (!detail) {
    log.warn('Builder callback for unknown job', { runId, jobId: run.job_id });
    return;
  }

  if (run.status === 'completed' || run.status === 'failed') {
    log.info('Ignoring duplicate builder callback', { runId, status: run.status });
    return;
  }

  if (result.status === 'failed' || result.status === 'timeout') {
    const error = result.error || result.detail || `Worker status: ${result.status}`;
    updateBuildRun(runId, 'failed', { worker_status: result.status, error });
    updateBuildJobStatus(detail.id, 'failed', { error });
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: detail.id,
      direction: 'outbound',
      role: 'system',
      content: { text: error },
      run_id: runId,
    });
    await deliverBuildText(detail, `Build failed: ${error}`);
    await cleanupBuilder(detail);
    return;
  }

  updateBuildRun(runId, 'completed', { worker_status: result.status });

  const outbound = result.outbound ?? [];
  for (const out of outbound) {
    const rawText =
      typeof out.content?.text === 'string' ? out.content.text : JSON.stringify(out.content ?? {});
    const displayText = stripBuildFence(rawText) || rawText;
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: detail.id,
      direction: 'outbound',
      role: 'builder',
      content: { ...out.content, text: displayText, raw_text: rawText },
      run_id: runId,
    });
    await deliverBuildText(detail, displayText);
  }

  const parsed = parseBuildResultFromOutbound(outbound);

  if (!parsed) {
    updateBuildJobStatus(detail.id, 'waiting_for_user');
    return;
  }

  if (parsed.status === 'needs_input' || parsed.status === 'progress') {
    updateBuildJobStatus(detail.id, 'waiting_for_user');
    return;
  }

  if (parsed.status === 'failed') {
    const error = parsed.error || 'Builder reported failure';
    updateBuildJobStatus(detail.id, 'failed', { error });
    await deliverBuildText(detail, `Build failed: ${error}`);
    await cleanupBuilder(detail);
    return;
  }

  if (parsed.status === 'completed') {
    // System completion notice is delivered inside finalizeCompletedBuild.
    // Avoid double-sending if builder already included human text above.
    await finalizeCompletedBuild(detail, parsed);
  }
}

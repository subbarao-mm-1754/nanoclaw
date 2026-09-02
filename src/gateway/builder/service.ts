import { getChannelAdapter } from '../../channels/channel-registry.js';
import { generateId } from '../auth.js';
import { createAgent, updateAgent } from '../agent-service.js';
import { ensureOnecliAgent } from '../integrations/onecli-sync.js';
import { log } from '../../log.js';
import {
  defaultContainerConfig,
  listAgentFiles,
  mergeAgentFiles,
  saveAgentFiles,
} from '../store/agent-files.js';
import { getAgentForUser } from '../store/agents.js';
import {
  createBuildJob,
  createBuildRun,
  getActiveBuildJobForUser,
  getActiveRunForJob,
  getBuildJob,
  getBuildJobDetail,
  getBuildJobForUser,
  getBuildRun,
  insertBuildMessage,
  listBuildJobsForUser,
  listBuildMessages,
  updateBuildJobStatus,
  updateBuildRun,
} from '../store/builds.js';
import { getWorkspace, registerWorkspace } from '../store/workspaces.js';
import { setConversationWorkspace } from '../store/conversations.js';
import type {
  BuildJob,
  BuildJobDetail,
  BuildMessage,
  BuildRun,
  GatewayAgent,
  GatewayAgentFile,
  GatewayUser,
} from '../types.js';
import {
  destroyWorkspaceOnWorker,
  enqueueProcessMessageOnWorker,
  prepareWorkspaceOnWorker,
} from '../worker-client.js';
import type { WorkerProcessMessageResponse } from '../../worker/types.js';
import { builderAgentFiles, editorAgentFiles } from './prompt.js';
import {
  filesFromMemoryPatch,
  looksLikeEditClaimWithoutFiles,
  looksLikeRegisterIntent,
  looksLikeUnregisteredCompletion,
  parseBuildResultFromOutbound,
  parseBuildResultFromText,
  stripBuildFence,
} from './parse-result.js';
import type { ParsedBuildResult } from '../types.js';
import { getUserById } from '../store/users.js';

export { looksLikeRegisterIntent } from './parse-result.js';

const BUILDER_NAME = 'Agent Builder';
const EDITOR_NAME = 'Agent Editor';

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

function previewWorkspaceId(jobId: string): string {
  return `ws-preview-${jobId}`;
}

function previewAgentGroupId(jobId: string): string {
  return `ag-preview-${jobId}`;
}

function previewSessionId(jobId: string, nonce?: string): string {
  return nonce ? `sess-preview-${jobId}-${nonce}` : `sess-preview-${jobId}`;
}

export function isEditJob(job: Pick<BuildJob, 'job_kind'>): boolean {
  return job.job_kind === 'edit';
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

export async function ensureBuilderWorkspace(
  user: GatewayUser,
  options?: { forceReplace?: boolean; files?: GatewayAgentFile[]; name?: string },
): Promise<{
  workspace_id: string;
  agent_group_id: string;
}> {
  const workspaceId = builderWorkspaceId(user.id);
  const agentGroupId = builderAgentGroupId(user.id);
  const name = options?.name ?? BUILDER_NAME;
  const files = options?.files ?? builderAgentFiles();
  const containerConfig = defaultContainerConfig(name);
  const forceReplace = options?.forceReplace === true;

  try {
    await prepareWorkspaceOnWorker({
      workspace_id: workspaceId,
      agent: {
        agent_group_id: agentGroupId,
        name,
        folder: `builder-${user.id}`,
        container_config: containerConfig,
        cli_scope: 'group',
        files,
      },
      options: { replace: forceReplace },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!forceReplace && /already exists/i.test(message)) {
      // Keep existing on-disk builder workspace between turns.
    } else {
      throw err;
    }
  }

  if (!getWorkspace(workspaceId)) {
    registerWorkspace({
      workspace_id: workspaceId,
      agent_group_id: agentGroupId,
      name,
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
  // Recreate builder workspace if it was deleted from disk (e.g. wiped worker-workspaces/).
  await ensureBuilderWorkspace(user);

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

  const builder = await ensureBuilderWorkspace(user, { forceReplace: true });
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

function editorWorkspaceFiles(agent: GatewayAgent): GatewayAgentFile[] {
  return [
    ...editorAgentFiles(agent.name),
    ...agent.files.map((file) => ({
      path: `current-agent/${file.path.replace(/^\/+/, '')}`,
      content: file.content,
    })),
  ];
}

function formatCurrentFiles(agent: GatewayAgent): string {
  if (agent.files.length === 0) return '(no files stored)';
  return agent.files.map((file) => `### ${file.path}\n${file.content}`).join('\n\n');
}

const CURRENT_AGENT_PREFIX = 'current-agent/';

/**
 * Map editor-emitted / memory-patch paths onto live agent file paths.
 * Builder workspace stores the agent under current-agent/; the preview agent
 * must load the same content at the root (CLAUDE.local.md, not current-agent/…).
 */
export function normalizeDraftAgentFiles(files: GatewayAgentFile[]): GatewayAgentFile[] {
  const byPath = new Map<string, GatewayAgentFile>();
  for (const file of files) {
    let path = file.path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!path || path.includes('..')) continue;
    if (path.startsWith(CURRENT_AGENT_PREFIX)) {
      path = path.slice(CURRENT_AGENT_PREFIX.length).replace(/^\/+/, '');
    }
    if (!path || path.includes('..')) continue;
    byPath.set(path, { path, content: file.content });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Prefer explicit nanoclaw-build files. Otherwise only take builder memory
 * patches under current-agent/ (never the editor's own CLAUDE.local.md).
 */
export function draftFilesFromEditTurn(
  parsed: ParsedBuildResult | null,
  patchFiles: GatewayAgentFile[],
): GatewayAgentFile[] {
  if (parsed?.files && parsed.files.length > 0) {
    return normalizeDraftAgentFiles(parsed.files);
  }

  const fromCurrentAgent = patchFiles.filter((file) => {
    const path = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    return path.startsWith(CURRENT_AGENT_PREFIX);
  });
  return normalizeDraftAgentFiles(fromCurrentAgent);
}

/** Latest draft files from builder messages (progress / needs_input / completed). */
function latestDraftFilesFromMessages(jobId: string): {
  files: GatewayAgentFile[];
  agentName?: string;
} {
  const messages = listBuildMessages(jobId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'builder') continue;
    const text =
      typeof msg.content.raw_text === 'string'
        ? msg.content.raw_text
        : typeof msg.content.text === 'string'
          ? msg.content.text
          : '';
    const parsed = parseBuildResultFromText(text);
    if (parsed?.files && parsed.files.length > 0) {
      return {
        files: normalizeDraftAgentFiles(parsed.files),
        agentName: parsed.agent_name,
      };
    }
    const memoryFiles = Array.isArray(msg.content.memory_files)
      ? (msg.content.memory_files as GatewayAgentFile[]).filter(
          (f) => f && typeof f.path === 'string' && typeof f.content === 'string',
        )
      : [];
    if (memoryFiles.length > 0) {
      return {
        files: normalizeDraftAgentFiles(memoryFiles),
        agentName: parsed?.agent_name,
      };
    }
  }
  return { files: [] };
}

/** Latest agent files from builder messages (any status fence, or stored memory_files). */
function latestBuildFilesFromMessages(jobId: string): {
  files: GatewayAgentFile[];
  agentName?: string;
} {
  return latestDraftFilesFromMessages(jobId);
}

function guessAgentNameFromMessages(job: BuildJob): string | undefined {
  if (job.title?.trim() && !/^create\b/i.test(job.title.trim())) {
    return job.title.trim();
  }
  const messages = listBuildMessages(job.id);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'builder') continue;
    const text =
      typeof msg.content.text === 'string'
        ? msg.content.text
        : typeof msg.content.raw_text === 'string'
          ? msg.content.raw_text
          : '';
    const named =
      text.match(/\*\*([^*]{2,64})\*\*/) ??
      text.match(/agent\s+[""']([^""']{2,64})[""']/i) ??
      text.match(/\b([A-Z][A-Za-z0-9_-]{2,40}Assistant)\b/);
    if (named?.[1]) return named[1].trim();
  }
  const fromTitle = job.title?.match(/\b([A-Z][A-Za-z0-9_-]{2,40}(?:Assistant|Bot|Agent)?)\b/);
  return fromTitle?.[1];
}

/** Tell the user the create build is ready — they finish with `/register`. */
async function promptCreateRegister(
  job: BuildJob,
  options?: { agentName?: string; runId?: string | null },
): Promise<void> {
  const name =
    options?.agentName?.trim() || guessAgentNameFromMessages(job) || 'your agent';
  const text = [
    `Build complete for "${name}".`,
    'Send `/register` to register it with the Gateway (this also cleans up the builder).',
  ].join('\n');

  updateBuildJobStatus(job.id, 'waiting_for_user');
  insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'outbound',
    role: 'system',
    content: { text, ready_to_register: true },
    run_id: options?.runId ?? null,
  });
  await deliverBuildText(job, text);
}

/** Create build claimed done but Gateway has no agent files yet. */
async function promptCreateNotReady(job: BuildJob, runId?: string | null): Promise<void> {
  const text =
    'Build is not ready to register yet — no agent definition files were produced. Keep chatting with the builder, or `/cancel` and `/build …` again.';
  updateBuildJobStatus(job.id, 'waiting_for_user');
  insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'outbound',
    role: 'system',
    content: { text },
    run_id: runId ?? null,
  });
  await deliverBuildText(job, text);
}

function filesEqual(
  a: GatewayAgentFile[],
  b: GatewayAgentFile[],
): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((f) => [f.path, f.content]));
  for (const file of b) {
    if (map.get(file.path) !== file.content) return false;
  }
  return true;
}

/** True when the preview draft is still identical to the live target agent. */
export function previewMatchesTarget(job: BuildJob): boolean {
  if (!job.preview_workspace_id || !job.target_workspace_id) return true;
  const preview = listAgentFiles(job.preview_workspace_id);
  const target = listAgentFiles(job.target_workspace_id);
  if (preview.length === 0) return true;
  return filesEqual(preview, target);
}

/** Builder outbound claimed an update but never emitted draft files. */
function editorClaimedEditWithoutFiles(jobId: string): boolean {
  return listBuildMessages(jobId).some((msg) => {
    if (msg.role !== 'builder') return false;
    const text =
      typeof msg.content.raw_text === 'string'
        ? msg.content.raw_text
        : typeof msg.content.text === 'string'
          ? msg.content.text
          : '';
    return text.length > 0 && looksLikeEditClaimWithoutFiles(text);
  });
}

/**
 * Editor claimed updates without emitting files — kick another builder turn that
 * must produce a nanoclaw-build files payload (once per claim streak).
 */
async function nudgeEditorToEmitFiles(job: BuildJob): Promise<void> {
  const user = getUserById(job.user_id);
  if (!user) return;

  const messages = listBuildMessages(job.id);
  const nudgeCount = messages.filter((m) => m.content.emit_files_nudge === true).length;
  if (nudgeCount >= 1) {
    await deliverBuildText(
      job,
      'The draft is still the **original** agent — the editor described changes but did not emit updated files. Reply: **emit the updated files now**.',
    );
    return;
  }

  const text = [
    'SYSTEM (Gateway): You told the user the draft was updated, but you did NOT include a',
    '```nanoclaw-build fence with a non-empty "files" array containing the full updated',
    'CLAUDE.local.md. `/test` still runs the ORIGINAL agent until you do.',
    '',
    'Emit status "needs_input" or "progress" NOW with the complete updated files.',
    'Do not only describe the changes in prose.',
  ].join('\n');

  await deliverBuildText(
    job,
    'Draft files were not updated yet — asking the editor to emit the full file contents so `/test` can use your changes…',
  );

  const message = insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'inbound',
    role: 'user',
    content: { text, emit_files_nudge: true },
  });

  const fresh = getBuildJob(job.id) ?? job;
  await startRun(fresh, message, user);
}

async function copyIntegrationsToPreview(sourceWorkspaceId: string, previewId: string): Promise<void> {
  try {
    const { listConnectionsForWorkspace, bindWorkspaceIntegration } = await import(
      '../integrations/store.js'
    );
    const { ensureWorkspaceIntegrations } = await import('../integrations/broker.js');
    for (const connection of listConnectionsForWorkspace(sourceWorkspaceId)) {
      bindWorkspaceIntegration(previewId, connection.id);
    }
    await ensureWorkspaceIntegrations(previewId);
  } catch (err) {
    log.warn('Failed to copy integrations onto edit preview', {
      sourceWorkspaceId,
      previewWorkspaceId: previewId,
      err,
    });
  }
}

async function preparePreviewWorkspace(job: BuildJob, agent: GatewayAgent): Promise<void> {
  const workspaceId = job.preview_workspace_id;
  const agentGroupId = job.preview_agent_group_id;
  if (!workspaceId || !agentGroupId) return;

  const files = listAgentFiles(workspaceId);
  const containerConfig = agent.container_config ?? defaultContainerConfig(agent.name);
  const draftName = `${agent.name} (draft)`;

  registerWorkspace({
    workspace_id: workspaceId,
    agent_group_id: agentGroupId,
    name: draftName,
    owner_user_id: agent.owner_user_id ?? job.user_id,
    folder: `preview-${job.id.slice(0, 16)}`,
    cli_scope: agent.cli_scope,
    container_config: containerConfig,
    is_default: false,
  });
  if (files.length === 0 && agent.files.length > 0) {
    saveAgentFiles(workspaceId, agent.files);
  }

  await prepareWorkspaceOnWorker({
    workspace_id: workspaceId,
    agent: {
      agent_group_id: agentGroupId,
      name: draftName,
      folder: `preview-${job.id.slice(0, 16)}`,
      container_config: containerConfig,
      cli_scope: agent.cli_scope,
      files: listAgentFiles(workspaceId),
    },
    options: { replace: true },
  });

  try {
    await ensureOnecliAgent({ name: draftName, identifier: agentGroupId });
  } catch (err) {
    log.warn('OneCLI ensureAgent failed for edit preview', { agentGroupId, err });
  }
}

async function syncEditPreview(
  job: BuildJob,
  files: GatewayAgentFile[],
  agentName?: string,
): Promise<BuildJob> {
  if (!isEditJob(job) || !job.preview_workspace_id || !job.preview_agent_group_id) return job;
  const normalized = normalizeDraftAgentFiles(files);
  if (normalized.length === 0) return job;

  // Preview workspace must exist in gateway_workspaces before saving files (FK).
  const target = job.target_workspace_id ? getWorkspace(job.target_workspace_id) : null;
  const displayName = agentName?.trim() || target?.name || job.title || 'Draft agent';
  const containerConfig = target?.container_config ?? defaultContainerConfig(displayName);
  const draftName = `${displayName} (draft)`;

  registerWorkspace({
    workspace_id: job.preview_workspace_id,
    agent_group_id: job.preview_agent_group_id,
    name: draftName,
    owner_user_id: target?.owner_user_id ?? job.user_id,
    folder: `preview-${job.id.slice(0, 16)}`,
    cli_scope: target?.cli_scope ?? 'group',
    container_config: containerConfig,
    is_default: false,
  });

  const existing = listAgentFiles(job.preview_workspace_id);
  const merged = mergeAgentFiles(existing, normalized);
  saveAgentFiles(job.preview_workspace_id, merged);

  const sessionNonce = generateId('s').slice(2, 10);
  const nextSessionId = previewSessionId(job.id, sessionNonce);

  await prepareWorkspaceOnWorker({
    workspace_id: job.preview_workspace_id,
    agent: {
      agent_group_id: job.preview_agent_group_id,
      name: draftName,
      folder: `preview-${job.id.slice(0, 16)}`,
      container_config: containerConfig,
      cli_scope: target?.cli_scope ?? 'group',
      files: merged,
    },
    options: { replace: true },
  });

  return updateBuildJobStatus(job.id, job.status, { preview_session_id: nextSessionId });
}

/**
 * Before /test: pull the latest draft from builder messages (if any), rematerialize
 * the preview workspace, and rotate the preview session so Claude does not resume
 * against a stale agent definition.
 */
async function refreshPreviewForTest(job: BuildJob): Promise<BuildJob> {
  if (!job.preview_workspace_id || !job.preview_agent_group_id) return job;

  const fromMessages = latestDraftFilesFromMessages(job.id);
  let current = job;
  if (fromMessages.files.length > 0) {
    current = await syncEditPreview(job, fromMessages.files, fromMessages.agentName);
  }

  const fresh = getBuildJob(current.id) ?? current;
  const files = listAgentFiles(fresh.preview_workspace_id!);
  if (files.length === 0) return fresh;

  const target = fresh.target_workspace_id ? getWorkspace(fresh.target_workspace_id) : null;
  const displayName = fromMessages.agentName?.trim() || target?.name || fresh.title || 'Draft agent';
  const containerConfig = target?.container_config ?? defaultContainerConfig(displayName);
  const draftName = `${displayName} (draft)`;
  const sessionNonce = generateId('s').slice(2, 10);
  const nextSessionId = previewSessionId(fresh.id, sessionNonce);

  registerWorkspace({
    workspace_id: fresh.preview_workspace_id!,
    agent_group_id: fresh.preview_agent_group_id!,
    name: draftName,
    owner_user_id: target?.owner_user_id ?? fresh.user_id,
    folder: `preview-${fresh.id.slice(0, 16)}`,
    cli_scope: target?.cli_scope ?? 'group',
    container_config: containerConfig,
    is_default: false,
  });

  await prepareWorkspaceOnWorker({
    workspace_id: fresh.preview_workspace_id!,
    agent: {
      agent_group_id: fresh.preview_agent_group_id!,
      name: draftName,
      folder: `preview-${fresh.id.slice(0, 16)}`,
      container_config: containerConfig,
      cli_scope: target?.cli_scope ?? 'group',
      files,
    },
    options: { replace: true },
  });

  try {
    await ensureOnecliAgent({ name: draftName, identifier: fresh.preview_agent_group_id! });
  } catch (err) {
    log.warn('OneCLI ensureAgent failed refreshing edit preview', {
      agentGroupId: fresh.preview_agent_group_id,
      err,
    });
  }

  if (fresh.target_workspace_id) {
    await copyIntegrationsToPreview(fresh.target_workspace_id, fresh.preview_workspace_id!);
  }

  return updateBuildJobStatus(fresh.id, fresh.status, { preview_session_id: nextSessionId });
}

export async function startEdit(
  user: GatewayUser,
  input: {
    agent: GatewayAgent;
    message?: string;
    delivery?: BuildDelivery;
  },
): Promise<BuildJobDetail> {
  const agent = getAgentForUser(input.agent.workspace_id, user.id);
  if (!agent) throw new BuildError('Agent not found', 404);

  const active = getActiveBuildJobForUser(user.id);
  if (active) {
    throw new BuildError(
      `An active ${isEditJob(active) ? 'edit' : 'build'} already exists (${active.id}). Reply to continue, or \`/cancel\` first.`,
      409,
    );
  }

  const builder = await ensureBuilderWorkspace(user, {
    forceReplace: true,
    name: EDITOR_NAME,
    files: editorWorkspaceFiles(agent),
  });

  const jobId = generateId('job');
  const previewWs = previewWorkspaceId(jobId);
  const previewAg = previewAgentGroupId(jobId);

  const job = createBuildJob({
    id: jobId,
    user_id: user.id,
    job_kind: 'edit',
    title: `Edit ${agent.name}`,
    builder_workspace_id: builder.workspace_id,
    builder_agent_group_id: builder.agent_group_id,
    builder_session_id: builderSessionId(jobId),
    target_workspace_id: agent.workspace_id,
    preview_workspace_id: previewWs,
    preview_agent_group_id: previewAg,
    preview_session_id: previewSessionId(jobId),
    delivery_channel_type: input.delivery?.channel_type ?? null,
    delivery_platform_id: input.delivery?.platform_id ?? null,
    delivery_thread_id: input.delivery?.thread_id ?? null,
  });

  await preparePreviewWorkspace(job, agent);
  await copyIntegrationsToPreview(agent.workspace_id, previewWs);

  const requested = input.message?.trim() || '';
  const text = [
    `Edit the existing user agent "${agent.name}" (id: ${agent.workspace_id}).`,
    'Do not create a new agent. Update this agent in place.',
    'This chat must stay bound to whatever agent it already uses — never switch Cliq.',
    'The user will `/test <message>` against a draft with the latest files you emit.',
    '',
    'Current files:',
    formatCurrentFiles(agent),
    '',
    requested ? `Requested changes:\n${requested}` : 'Ask what the user wants to change.',
  ].join('\n');

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

export async function runPreviewTest(
  user: GatewayUser,
  jobId: string,
  input: { message: string },
): Promise<BuildJobDetail> {
  const text = input.message.trim();
  if (!text) throw new BuildError('Usage: `/test <message to send to the draft agent>`');

  const job = getBuildJobForUser(jobId, user.id);
  if (!job) throw new BuildError('Build job not found', 404);
  if (!isEditJob(job)) {
    throw new BuildError('`/test` is only available while editing an agent (`/edit …`).');
  }
  if (job.status === 'completed' || job.status === 'failed') {
    throw new BuildError(`Edit job is already ${job.status}`, 409);
  }
  if (!job.preview_workspace_id || !job.preview_agent_group_id || !job.preview_session_id) {
    throw new BuildError('Edit preview is not ready yet. Wait for the editor to finish this turn.');
  }

  const runningTest = getActiveRunForJob(job.id, 'test');
  if (runningTest) {
    throw new BuildError('A test is already running. Wait for the draft reply.', 409);
  }

  if (job.status === 'in_progress') {
    const builderBusy = getActiveRunForJob(job.id, 'builder');
    if (builderBusy) {
      throw new BuildError(
        'Editor is still working on the previous reply. Wait until it finishes, then `/test` again so the draft includes the new changes.',
        409,
      );
    }
  }

  // Refresh from any files the editor already emitted, then verify the draft moved.
  let previewJob: BuildJob;
  try {
    previewJob = await refreshPreviewForTest(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BuildError(`Could not refresh edit draft for testing: ${message}`);
  }

  // Only block /test when the editor claimed updates without emitting files.
  // An unchanged draft (no edits yet, or editor still asking questions) is fine to test.
  if (previewMatchesTarget(previewJob) && editorClaimedEditWithoutFiles(previewJob.id)) {
    await nudgeEditorToEmitFiles(previewJob);
    throw new BuildError(
      'Draft still matches the original agent — your edits were described in chat but not written into draft files yet. Wait for the editor to emit the updated `CLAUDE.local.md`, then `/test` again.',
      409,
    );
  }

  if (!previewJob.preview_workspace_id || !previewJob.preview_agent_group_id || !previewJob.preview_session_id) {
    throw new BuildError('Edit preview is not ready yet. Wait for the editor to finish this turn.');
  }
  if (listAgentFiles(previewJob.preview_workspace_id).length === 0) {
    throw new BuildError('Draft has no files to test yet.');
  }

  const target = previewJob.target_workspace_id
    ? getAgentForUser(previewJob.target_workspace_id, user.id)
    : null;
  const agentName = target?.name ?? previewJob.title ?? 'draft';

  const runId = generateId('run');
  createBuildRun({ id: runId, job_id: previewJob.id, kind: 'test' });

  const inboundId = generateId('bmsg');
  insertBuildMessage({
    id: inboundId,
    job_id: previewJob.id,
    direction: 'inbound',
    role: 'user',
    content: { text, test: true },
    run_id: runId,
  });

  const delivery = deliveryForJob(previewJob, user);

  try {
    await enqueueProcessMessageOnWorker(
      {
        job_id: runId,
        build_job_id: previewJob.id,
        workspace_id: previewJob.preview_workspace_id,
        session: {
          id: previewJob.preview_session_id,
          agent_group_id: previewJob.preview_agent_group_id,
        },
        delivery: {
          channel_type: delivery.channel_type,
          platform_id: delivery.platform_id,
          thread_id: delivery.thread_id,
          name: 'client',
          display_name: user.display_name,
        },
        inbound: {
          id: inboundId,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: { text },
          sender: { id: user.id, display_name: user.display_name },
        },
      },
      previewJob.id,
    );
    updateBuildRun(runId, 'running');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateBuildRun(runId, 'failed', { error: message });
    throw err;
  }

  await deliverBuildText(
    previewJob,
    `Testing draft of "${agentName}" with edits so far (this chat’s agent is unchanged)…`,
  );
  return getBuildJobDetail(previewJob.id)!;
}

export async function saveEdit(user: GatewayUser, jobId?: string): Promise<BuildJobDetail> {
  const job = jobId ? getBuildJobForUser(jobId, user.id) : getActiveBuildJobForUser(user.id);
  if (!job) throw new BuildError('No active edit to save', 404);
  if (!isEditJob(job)) {
    throw new BuildError(
      'This is a create build. Ask the builder to emit a completed block, or `/register`.',
    );
  }
  if (job.status === 'completed') return getBuildJobDetail(job.id)!;
  if (job.status === 'failed') {
    throw new BuildError('Edit already failed — start a new one with `/edit …`.', 409);
  }
  if (!job.target_workspace_id || !job.preview_workspace_id) {
    throw new BuildError('Edit preview is missing.', 409);
  }

  const files = listAgentFiles(job.preview_workspace_id);
  if (files.length === 0) {
    throw new BuildError('No draft files to save yet. Ask the editor to emit updated files, then `/save`.');
  }

  const target = getAgentForUser(job.target_workspace_id, user.id);
  await finalizeCompletedEdit(job, {
    status: 'completed',
    agent_name: target?.name,
    files,
  });
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
  const cancelledLabel = isEditJob(job) ? 'Edit' : 'Build';
  insertBuildMessage({
    id: generateId('bmsg'),
    job_id: job.id,
    direction: 'outbound',
    role: 'system',
    content: { text: `${cancelledLabel} cancelled.` },
  });
  await cleanupBuilder(job);
  await deliverBuildText(
    job,
    isEditJob(job)
      ? 'Edit cancelled. This chat is still using the same agent as before. `/edit …` to try again, or send a normal message to talk to it.'
      : 'Build cancelled. You can start a new one with `/build …`.',
  );
  return getBuildJobDetail(job.id)!;
}

/**
 * Register the agent from stored builder files (completed / progress fences or
 * memory patches), then clean up the builder. Used via `/register`.
 */
export async function registerBuildFromStoredMessages(
  user: GatewayUser,
  jobId?: string,
): Promise<BuildJobDetail> {
  const job = jobId ? getBuildJobForUser(jobId, user.id) : getActiveBuildJobForUser(user.id);
  if (!job) throw new BuildError('No active build to register', 404);
  if (job.status === 'completed') return getBuildJobDetail(job.id)!;
  if (job.status === 'failed') {
    throw new BuildError(
      isEditJob(job)
        ? 'Edit already failed — start a new one with `/edit …`.'
        : 'Build already failed — start a new one with `/build …`.',
      409,
    );
  }

  const messages = listBuildMessages(job.id);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'builder') continue;
    const text =
      typeof msg.content.raw_text === 'string'
        ? msg.content.raw_text
        : typeof msg.content.text === 'string'
          ? msg.content.text
          : '';
    const parsed = parseBuildResultFromText(text);
    if (parsed?.status === 'completed' && parsed.files && parsed.files.length > 0) {
      if (isEditJob(job)) await finalizeCompletedEdit(job, parsed);
      else await finalizeCompletedBuild(job, parsed);
      return getBuildJobDetail(job.id)!;
    }
  }

  const fromMessages = latestBuildFilesFromMessages(job.id);
  if (fromMessages.files.length > 0) {
    const parsed: ParsedBuildResult = {
      status: 'completed',
      agent_name: fromMessages.agentName ?? guessAgentNameFromMessages(job),
      files: fromMessages.files,
    };
    if (isEditJob(job)) await finalizeCompletedEdit(job, parsed);
    else await finalizeCompletedBuild(job, parsed);
    return getBuildJobDetail(job.id)!;
  }

  if (isEditJob(job)) {
    return saveEdit(user, job.id);
  }

  throw new BuildError(
    'No agent files to register yet. Keep chatting with the builder until it finishes the definition, then send `/register` again — or `/cancel` and `/build …`.',
  );
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

  if (job.preview_workspace_id) {
    try {
      await destroyWorkspaceOnWorker({
        workspace_id: job.preview_workspace_id,
        session_id: job.preview_session_id ?? undefined,
      });
    } catch (err) {
      log.warn('Failed to destroy edit preview workspace', {
        jobId: job.id,
        workspaceId: job.preview_workspace_id,
        err,
      });
    }
  }
}

async function attachPendingMcp(job: BuildJob, workspaceId: string, agentGroupId: string): Promise<void> {
  const freshJob = getBuildJob(job.id) ?? job;
  if (!freshJob.pending_connection_id) return;
  try {
    const { applyBuildPendingMcpToAgent } = await import('../integrations/broker.js');
    const { ensureWorkspaceOnWorker } = await import('../agent-service.js');
    await applyBuildPendingMcpToAgent(freshJob, workspaceId, agentGroupId);
    await ensureWorkspaceOnWorker(workspaceId);
  } catch (err) {
    log.warn('Failed to attach pending MCP to agent', { jobId: job.id, workspaceId, err });
  }
}

async function finalizeCompletedEdit(
  job: BuildJob,
  parsed: ParsedBuildResult,
): Promise<GatewayAgent | null> {
  const files = parsed.files ?? [];
  if (files.length === 0 || !job.target_workspace_id) {
    updateBuildJobStatus(job.id, 'failed', {
      error: 'Editor marked completed but returned no agent files',
    });
    await deliverBuildText(
      job,
      'Edit failed: no agent files were produced. Start again with `/edit …`.',
    );
    await cleanupBuilder(job);
    return null;
  }

  const existing = getAgentForUser(job.target_workspace_id, job.user_id);
  if (!existing) {
    updateBuildJobStatus(job.id, 'failed', { error: 'Agent to edit was not found' });
    await deliverBuildText(job, 'Edit failed: the agent no longer exists.');
    await cleanupBuilder(job);
    return null;
  }

  const agentName = parsed.agent_name?.trim() || existing.name;
  const agent = await updateAgent(job.target_workspace_id, job.user_id, {
    name: agentName !== existing.name ? agentName : undefined,
    files,
  });

  await attachPendingMcp(job, agent.workspace_id, agent.agent_group_id);

  updateBuildJobStatus(job.id, 'completed', {
    result_workspace_id: agent.workspace_id,
    result_agent_group_id: agent.agent_group_id,
    title: agentName,
  });

  const doneText = [
    `Agent "${agentName}" updated.`,
    `id: \`${agent.workspace_id}\``,
    '',
    'This chat is still using the same agent as before the edit. Switch with `/use <name>` if you want to talk to the updated agent here.',
    'Edit another with `/edit …`, or `/test` is no longer needed.',
  ].join('\n');

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

async function finalizeCompletedBuild(
  job: BuildJob,
  parsed: ParsedBuildResult,
): Promise<GatewayAgent | null> {
  const files = parsed.files ?? [];
  if (files.length === 0) {
    updateBuildJobStatus(job.id, 'failed', {
      error: 'Builder marked completed but returned no agent files',
    });
    await deliverBuildText(
      job,
      'Build failed: no agent files were produced. Start again with `/build …` and make sure the final reply includes a ```nanoclaw-build completed block with files.',
    );
    await cleanupBuilder(job);
    return null;
  }

  const agentName = parsed.agent_name?.trim() || job.title || 'New Agent';
  const agent = await createAgent({
    name: agentName,
    owner_user_id: job.user_id,
    files,
    is_default: false,
  });

  await attachPendingMcp(job, agent.workspace_id, agent.agent_group_id);

  updateBuildJobStatus(job.id, 'completed', {
    result_workspace_id: agent.workspace_id,
    result_agent_group_id: agent.agent_group_id,
    title: agentName,
  });

  // Bind this channel chat to the new agent so the next message goes there.
  if (job.delivery_channel_type && job.delivery_platform_id) {
    try {
      setConversationWorkspace({
        channel_type: job.delivery_channel_type,
        platform_id: job.delivery_platform_id,
        thread_id: job.delivery_thread_id,
        workspace_id: agent.workspace_id,
      });
    } catch (err) {
      log.warn('Failed to bind chat to newly built agent', {
        jobId: job.id,
        workspaceId: agent.workspace_id,
        err,
      });
    }
  }

  const doneText = [
    `Agent "${agentName}" created and this chat is now using it.`,
    `id: \`${agent.workspace_id}\``,
    '',
    'Next messages here go to this agent. Switch later with `/agents` and `/use <name>`.',
    'Build another with `/build …`.',
  ].join('\n');

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

async function handlePreviewTestCallback(
  run: BuildRun,
  job: BuildJob,
  result: WorkerProcessMessageResponse,
): Promise<void> {
  const target = job.target_workspace_id ? getWorkspace(job.target_workspace_id) : null;
  const agentName = target?.name ?? job.title ?? 'draft';
  const prefix = `[test · ${agentName} draft]`;

  if (result.status === 'failed' || result.status === 'timeout') {
    const error = result.error || result.detail || `Worker status: ${result.status}`;
    updateBuildRun(run.id, 'failed', { worker_status: result.status, error });
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: job.id,
      direction: 'outbound',
      role: 'system',
      content: { text: error, test: true },
      run_id: run.id,
    });
    await deliverBuildText(job, `${prefix}\nTest failed: ${error}`);
    return;
  }

  updateBuildRun(run.id, 'completed', { worker_status: result.status });

  const outbound = result.outbound ?? [];
  if (outbound.length === 0) {
    const empty = `${prefix}\nDraft agent produced no reply.`;
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: job.id,
      direction: 'outbound',
      role: 'system',
      content: { text: empty, test: true },
      run_id: run.id,
    });
    await deliverBuildText(job, empty);
    return;
  }

  for (const out of outbound) {
    const rawText =
      typeof out.content?.text === 'string' ? out.content.text : JSON.stringify(out.content ?? {});
    const displayText = `${prefix}\n${rawText}`.trim();
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: job.id,
      direction: 'outbound',
      role: 'system',
      content: { ...out.content, text: displayText, test: true },
      run_id: run.id,
    });
    await deliverBuildText(job, displayText);
  }
}

/**
 * Worker → Gateway callback for one builder or preview-test run.
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

  if (run.kind === 'test') {
    await handlePreviewTestCallback(run, detail, result);
    return;
  }

  const failLabel = isEditJob(detail) ? 'Edit' : 'Build';

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
    await deliverBuildText(detail, `${failLabel} failed: ${error}`);
    await cleanupBuilder(detail);
    return;
  }

  updateBuildRun(runId, 'completed', { worker_status: result.status });

  const outbound = result.outbound ?? [];
  const outboundTexts: string[] = [];
  const patchFiles = filesFromMemoryPatch(result.memory_patch);

  for (let i = 0; i < outbound.length; i++) {
    const out = outbound[i]!;
    const rawText =
      typeof out.content?.text === 'string' ? out.content.text : JSON.stringify(out.content ?? {});
    const displayText = stripBuildFence(rawText) || rawText;
    outboundTexts.push(rawText);
    const isLast = i === outbound.length - 1;
    insertBuildMessage({
      id: generateId('bmsg'),
      job_id: detail.id,
      direction: 'outbound',
      role: 'builder',
      content: {
        ...out.content,
        text: displayText,
        raw_text: rawText,
        ...(isLast && patchFiles.length > 0 ? { memory_files: patchFiles } : {}),
      },
      run_id: runId,
    });
    await deliverBuildText(detail, displayText);
  }

  let parsed = parseBuildResultFromOutbound(outbound);

  if (parsed?.status === 'completed' && (!parsed.files || parsed.files.length === 0) && patchFiles.length > 0) {
    const fromPatch = draftFilesFromEditTurn(null, patchFiles);
    if (fromPatch.length > 0) {
      parsed = { ...parsed, files: fromPatch };
    } else if (!isEditJob(detail)) {
      parsed = { ...parsed, files: patchFiles };
    }
  }

  const claimedCreateWithoutFence =
    !isEditJob(detail) && outboundTexts.some((t) => looksLikeUnregisteredCompletion(t));

  // Create builds: if the model claimed done (or returned completed) but only
  // wrote files via tools / memory patch, treat that as a completed payload so
  // `/register` can pick them up.
  if (
    !isEditJob(detail) &&
    (!parsed || !parsed.files || parsed.files.length === 0) &&
    patchFiles.length > 0 &&
    (claimedCreateWithoutFence || parsed?.status === 'completed')
  ) {
    parsed = {
      status: 'completed',
      agent_name: parsed?.agent_name ?? guessAgentNameFromMessages(detail),
      files: patchFiles,
    };
  }

  const draftFiles = isEditJob(detail)
    ? draftFilesFromEditTurn(parsed, patchFiles)
    : parsed?.files?.length
      ? parsed.files
      : patchFiles;
  if (isEditJob(detail) && draftFiles.length > 0) {
    try {
      await syncEditPreview(detail, draftFiles, parsed?.agent_name);
    } catch (err) {
      log.warn('Failed to refresh edit preview from builder files', { jobId: detail.id, err });
    }
  }

  const claimedEditWithoutFiles =
    isEditJob(detail) &&
    draftFiles.length === 0 &&
    outboundTexts.some((t) => looksLikeEditClaimWithoutFiles(t));

  if (!parsed) {
    if (claimedEditWithoutFiles) {
      updateBuildJobStatus(detail.id, 'waiting_for_user');
      await nudgeEditorToEmitFiles(getBuildJob(detail.id) ?? detail);
      return;
    }
    if (claimedCreateWithoutFence) {
      const prior = latestBuildFilesFromMessages(detail.id);
      if (prior.files.length > 0 || patchFiles.length > 0) {
        await promptCreateRegister(detail, {
          agentName: prior.agentName ?? guessAgentNameFromMessages(detail),
          runId,
        });
      } else {
        await promptCreateNotReady(detail, runId);
      }
      return;
    }
    updateBuildJobStatus(detail.id, 'waiting_for_user');
    return;
  }

  if (parsed.status === 'needs_input' || parsed.status === 'progress') {
    updateBuildJobStatus(detail.id, 'waiting_for_user');
    if (claimedEditWithoutFiles) {
      await nudgeEditorToEmitFiles(getBuildJob(detail.id) ?? detail);
      return;
    }
    if (claimedCreateWithoutFence) {
      const files = parsed.files?.length ? parsed.files : draftFiles;
      if (files.length > 0) {
        await promptCreateRegister(detail, {
          agentName: parsed.agent_name ?? guessAgentNameFromMessages(detail),
          runId,
        });
      } else {
        await promptCreateNotReady(detail, runId);
      }
      return;
    }
    if (isEditJob(detail) && draftFiles.length > 0) {
      const hint = 'Draft updated. `/test <message>` to try it — this chat’s agent stays unchanged. `/save` when you are happy.';
      insertBuildMessage({
        id: generateId('bmsg'),
        job_id: detail.id,
        direction: 'outbound',
        role: 'system',
        content: { text: hint },
        run_id: runId,
      });
      await deliverBuildText(detail, hint);
    }
    return;
  }

  if (parsed.status === 'failed') {
    const error = parsed.error || 'Builder reported failure';
    updateBuildJobStatus(detail.id, 'failed', { error });
    await deliverBuildText(detail, `${failLabel} failed: ${error}`);
    await cleanupBuilder(detail);
    return;
  }

  if (parsed.status === 'completed') {
    if (isEditJob(detail)) {
      await finalizeCompletedEdit(detail, parsed);
      return;
    }
    // Create builds wait for an explicit `/register` before creating the agent.
    const files = parsed.files ?? [];
    if (files.length === 0) {
      await promptCreateNotReady(detail, runId);
      return;
    }
    await promptCreateRegister(detail, {
      agentName: parsed.agent_name ?? guessAgentNameFromMessages(detail),
      runId,
    });
  }
}

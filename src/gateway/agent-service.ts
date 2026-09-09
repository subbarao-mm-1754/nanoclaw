import type { ContainerConfigSnapshot } from '../container-config.js';
import { log } from '../log.js';
import { computeWorkspaceContentHash } from '../workspace-content-hash.js';
import { generateId, slugifyName } from './auth.js';
import { ensureWorkspaceIntegrations } from './integrations/broker.js';
import { ensureOnecliAgent } from './integrations/onecli-sync.js';
import type { GatewayAgent, GatewayAgentFile } from './types.js';
import {
  AgentDeleteError,
  createAgentRecord,
  deleteAgentRecord,
  getAgentForUser,
  updateAgentFilesRecord,
  updateAgentMetadata,
  type DeleteAgentResult,
} from './store/agents.js';
import {
  applyGlobalContainerDefaults,
  defaultContainerConfig,
  listAgentFiles,
} from './store/agent-files.js';
import { mergeFilesWithBrowserSessions } from './store/browser-sessions.js';
import { getActiveBuildJobForUser } from './store/builds.js';
import { getUserById } from './store/users.js';
import {
  clearWorkerContentHash,
  getWorkspace,
  setWorkerContentHash,
} from './store/workspaces.js';
import { destroyWorkspaceOnWorker, prepareWorkspaceOnWorker } from './worker-client.js';

function buildPreparePayload(
  workspace: {
    workspace_id: string;
    agent_group_id: string;
    name: string;
    folder: string | null;
    cli_scope: string;
    container_config: ContainerConfigSnapshot | null;
  },
  files: GatewayAgentFile[],
  options: { replace?: boolean; refresh?: boolean; ensure?: boolean } = {},
) {
  // Inject bound browser session storageState files (not stored in agent_files).
  const filesWithSessions = mergeFilesWithBrowserSessions(workspace.workspace_id, files);
  return {
    workspace_id: workspace.workspace_id,
    agent: {
      agent_group_id: workspace.agent_group_id,
      name: workspace.name,
      folder: workspace.folder ?? undefined,
      container_config: applyGlobalContainerDefaults(workspace.container_config, workspace.name),
      cli_scope: workspace.cli_scope,
      files: filesWithSessions,
    },
    options,
  };
}

function payloadContentHash(
  payload: ReturnType<typeof buildPreparePayload>,
): string {
  return computeWorkspaceContentHash({
    agent_group_id: payload.agent.agent_group_id,
    name: payload.agent.name,
    folder: payload.agent.folder,
    cli_scope: payload.agent.cli_scope,
    container_config: payload.agent.container_config,
    files: payload.agent.files,
  });
}

/**
 * Ensure the Worker has an on-disk workspace for this agent.
 * Creates from Gateway DB files when missing; refreshes in place when content
 * changed; skips the Worker HTTP call when Gateway's cached content hash still
 * matches (steady-state inbound messages).
 *
 * Pass `force: true` after a Worker "workspace missing" failure so disk is
 * rematerialized even if the Gateway hash cache is stale.
 */
export async function ensureWorkspaceOnWorker(
  workspaceId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Gateway workspace not found: ${workspaceId}`);
  }

  let files = listAgentFiles(workspaceId);
  if (files.length === 0) {
    files = [{ path: 'CLAUDE.local.md', content: `# ${workspace.name}\n` }];
  }

  await ensureWorkspaceIntegrations(workspaceId);
  // Re-read workspace — integrations may have updated container_config (remote MCP).
  const refreshed = getWorkspace(workspaceId) ?? workspace;
  files = listAgentFiles(workspaceId);
  if (files.length === 0) {
    files = [{ path: 'CLAUDE.local.md', content: `# ${refreshed.name}\n` }];
  }

  const payload = buildPreparePayload(refreshed, files, { ensure: true });
  const contentHash = payloadContentHash(payload);

  if (!options.force && refreshed.worker_content_hash === contentHash) {
    // Hot path: nothing changed — no Worker call, no log noise.
    return;
  }

  const result = await prepareWorkspaceOnWorker(payload);
  setWorkerContentHash(workspaceId, result.content_hash);

  // Worker already logs create/refresh/replace; only note Gateway-side force rematerialize.
  if (options.force && result.status === 'prepared') {
    log.info('Worker workspace rematerialized after missing-on-disk', {
      workspaceId,
      filesWritten: result.files_written.length,
      contentHash: result.content_hash,
    });
  }
}

/** Clear cached hash so the next ensure rematerializes on the Worker. */
export function invalidateWorkerWorkspaceCache(workspaceId: string): void {
  try {
    clearWorkerContentHash(workspaceId);
  } catch {
    // Workspace may already be deleted.
  }
}

export function isWorkerWorkspaceMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /workspace (not found|agent directory missing)/i.test(message);
}

export async function createAgent(input: {
  name: string;
  owner_user_id: string;
  folder?: string;
  cli_scope?: string;
  container_config?: ContainerConfigSnapshot;
  files: GatewayAgentFile[];
  is_default?: boolean;
}): Promise<GatewayAgent> {
  if (input.files.length === 0) {
    throw new Error('At least one agent file is required (e.g. CLAUDE.local.md)');
  }

  const workspaceId = generateId('ws');
  const agentGroupId = generateId('ag');
  const folder = input.folder ?? slugifyName(input.name);
  const containerConfig = applyGlobalContainerDefaults(
    input.container_config ?? defaultContainerConfig(input.name),
    input.name,
  );
  const cliScope = input.cli_scope ?? 'group';

  const draft = {
    workspace_id: workspaceId,
    agent_group_id: agentGroupId,
    name: input.name,
    folder,
    cli_scope: cliScope,
    container_config: containerConfig,
    is_default: input.is_default ?? false,
    owner_user_id: input.owner_user_id,
    created_at: '',
    updated_at: '',
  };

  const prepared = await prepareWorkspaceOnWorker(buildPreparePayload(draft, input.files, {}));

  const agent = createAgentRecord({
    ...input,
    workspace_id: workspaceId,
    agent_group_id: agentGroupId,
    folder,
    container_config: containerConfig,
    cli_scope: cliScope,
  });

  setWorkerContentHash(workspaceId, prepared.content_hash);

  try {
    await ensureOnecliAgent({ name: input.name, identifier: agentGroupId });
  } catch (err) {
    log.warn('OneCLI ensureAgent failed during gateway createAgent', { agentGroupId, err });
  }

  // Sync integrations; re-ensure only if MCP/config changed the content hash.
  await ensureWorkspaceIntegrations(workspaceId);
  await ensureWorkspaceOnWorker(workspaceId);

  return getAgentForUser(agent.workspace_id, input.owner_user_id)!;
}

export async function updateAgentFiles(
  workspaceId: string,
  userId: string,
  files: GatewayAgentFile[],
): Promise<GatewayAgent> {
  if (files.length === 0) throw new Error('At least one file update is required');

  updateAgentFilesRecord(workspaceId, userId, files);
  await ensureWorkspaceOnWorker(workspaceId);
  return getAgentForUser(workspaceId, userId)!;
}

export async function updateAgent(
  workspaceId: string,
  userId: string,
  input: {
    name?: string;
    container_config?: ContainerConfigSnapshot;
    cli_scope?: string;
    is_default?: boolean;
    files?: GatewayAgentFile[];
  },
): Promise<GatewayAgent> {
  let agent = getAgentForUser(workspaceId, userId);
  if (!agent) throw new Error('Agent not found');

  const hasMeta =
    input.name !== undefined ||
    input.container_config !== undefined ||
    input.cli_scope !== undefined ||
    input.is_default !== undefined;

  if (hasMeta) {
    agent = updateAgentMetadata(workspaceId, userId, {
      name: input.name,
      container_config: input.container_config
        ? applyGlobalContainerDefaults(input.container_config, input.name ?? agent.name)
        : undefined,
      cli_scope: input.cli_scope,
      is_default: input.is_default,
    });
  }

  if (input.files && input.files.length > 0) {
    return updateAgentFiles(workspaceId, userId, input.files);
  }

  if (hasMeta) {
    await ensureWorkspaceOnWorker(workspaceId);
    return getAgentForUser(workspaceId, userId)!;
  }

  return agent;
}

export function getAgent(workspaceId: string, userId: string): GatewayAgent | null {
  return getAgentForUser(workspaceId, userId);
}

export function agentExists(workspaceId: string): boolean {
  return getWorkspace(workspaceId) !== null;
}

export async function deleteAgent(workspaceId: string, userId: string): Promise<DeleteAgentResult> {
  const agent = getAgentForUser(workspaceId, userId);
  if (!agent) {
    throw new AgentDeleteError('Agent not found', 404);
  }

  const active = getActiveBuildJobForUser(userId);
  if (
    active &&
    (active.target_workspace_id === workspaceId || active.result_workspace_id === workspaceId) &&
    (active.status === 'in_progress' || active.status === 'waiting_for_user')
  ) {
    const user = getUserById(userId);
    if (user) {
      try {
        const { cancelBuild } = await import('./builder/service.js');
        await cancelBuild(user, active.id);
      } catch (err) {
        log.warn('Failed to cancel active build/edit before deleting agent', {
          workspaceId,
          jobId: active.id,
          err,
        });
      }
    }
  }

  try {
    await destroyWorkspaceOnWorker({ workspace_id: workspaceId });
  } catch (err) {
    log.warn('Failed to destroy worker workspace while deleting agent', { workspaceId, err });
  }

  return deleteAgentRecord(workspaceId, userId);
}

import type { ContainerConfigSnapshot } from '../container-config.js';
import { log } from '../log.js';
import { generateId, slugifyName } from './auth.js';
import { ensureWorkspaceIntegrations } from './integrations/broker.js';
import { ensureOnecliAgent } from './integrations/onecli-sync.js';
import type { GatewayAgent, GatewayAgentFile } from './types.js';
import { prepareWorkspaceOnWorker } from './worker-client.js';
import {
  createAgentRecord,
  getAgentFilesForPrepare,
  getAgentForUser,
  updateAgentFilesRecord,
  updateAgentMetadata,
} from './store/agents.js';
import { defaultContainerConfig, listAgentFiles } from './store/agent-files.js';
import { getWorkspace } from './store/workspaces.js';

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
  replace: boolean,
) {
  return {
    workspace_id: workspace.workspace_id,
    agent: {
      agent_group_id: workspace.agent_group_id,
      name: workspace.name,
      folder: workspace.folder ?? undefined,
      container_config: workspace.container_config ?? defaultContainerConfig(workspace.name),
      cli_scope: workspace.cli_scope,
      files,
    },
    options: { replace },
  };
}

function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

/**
 * Ensure the Worker has an on-disk workspace for this agent.
 * Creates from Gateway DB files when missing (e.g. after deleting worker-workspaces/).
 * No-op if the workspace already exists on the Worker.
 */
export async function ensureWorkspaceOnWorker(workspaceId: string): Promise<void> {
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

  try {
    await prepareWorkspaceOnWorker(buildPreparePayload(refreshed, files, false));
    log.info('Worker workspace prepared (was missing)', { workspaceId });
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      // Refresh disk materialization so OneCLI-synced remote MCP config is current.
      await prepareWorkspaceOnWorker(buildPreparePayload(refreshed, files, true));
      return;
    }
    throw err;
  }
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
  const containerConfig = input.container_config ?? defaultContainerConfig(input.name);
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

  await prepareWorkspaceOnWorker(buildPreparePayload(draft, input.files, false));

  const agent = createAgentRecord({
    ...input,
    workspace_id: workspaceId,
    agent_group_id: agentGroupId,
    folder,
    container_config: containerConfig,
    cli_scope: cliScope,
  });

  try {
    await ensureOnecliAgent({ name: input.name, identifier: agentGroupId });
  } catch (err) {
    log.warn('OneCLI ensureAgent failed during gateway createAgent', { agentGroupId, err });
  }

  // Refresh/sync any integrations bound after create (usually none yet).
  await ensureWorkspaceIntegrations(workspaceId);

  return getAgentForUser(agent.workspace_id, input.owner_user_id)!;
}

export async function updateAgentFiles(
  workspaceId: string,
  userId: string,
  files: GatewayAgentFile[],
): Promise<GatewayAgent> {
  if (files.length === 0) throw new Error('At least one file update is required');

  const agent = updateAgentFilesRecord(workspaceId, userId, files);
  await ensureWorkspaceIntegrations(workspaceId);
  await prepareWorkspaceOnWorker(buildPreparePayload(agent, agent.files, true));
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
      container_config: input.container_config,
      cli_scope: input.cli_scope,
      is_default: input.is_default,
    });
  }

  if (input.files && input.files.length > 0) {
    return updateAgentFiles(workspaceId, userId, input.files);
  }

  if (hasMeta) {
    const files = getAgentFilesForPrepare(workspaceId);
    await ensureWorkspaceIntegrations(workspaceId);
    await prepareWorkspaceOnWorker(buildPreparePayload(agent, files, true));
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

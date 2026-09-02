import { generateId, slugifyName } from '../auth.js';
import type { ContainerConfigSnapshot } from '../../container-config.js';
import type { GatewayAgent, GatewayAgentFile } from '../types.js';
import {
  assertAgentOwner,
  defaultContainerConfig,
  listAgentFiles,
  mergeAgentFiles,
  saveAgentFiles,
} from './agent-files.js';
import {
  deleteConversationsForWorkspace,
  rebindConversationsToWorkspace,
} from './conversations.js';
import {
  deleteWorkspace,
  getWorkspace,
  listAgentsForUser,
  registerWorkspace,
  updateWorkspaceMetadata,
} from './workspaces.js';

export { listAgentsForUser, assertAgentOwner, defaultContainerConfig, mergeAgentFiles };

function isDeletableUserAgent(workspaceId: string): boolean {
  return !workspaceId.startsWith('ws-builder-') && !workspaceId.startsWith('ws-preview-');
}

export class AgentDeleteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentDeleteError';
  }
}

export function getAgentForUser(workspaceId: string, userId: string): GatewayAgent | null {
  const workspace = getWorkspace(workspaceId);
  if (!workspace || workspace.owner_user_id !== userId) return null;
  return { ...workspace, files: listAgentFiles(workspaceId) };
}

export function createAgentRecord(input: {
  name: string;
  owner_user_id: string;
  folder?: string;
  cli_scope?: string;
  container_config?: ContainerConfigSnapshot;
  files: GatewayAgentFile[];
  is_default?: boolean;
  workspace_id?: string;
  agent_group_id?: string;
}): GatewayAgent {
  const workspaceId = input.workspace_id ?? generateId('ws');
  const agentGroupId = input.agent_group_id ?? generateId('ag');
  const folder = input.folder ?? slugifyName(input.name);
  const containerConfig = input.container_config ?? defaultContainerConfig(input.name);

  const workspace = registerWorkspace({
    workspace_id: workspaceId,
    agent_group_id: agentGroupId,
    name: input.name,
    owner_user_id: input.owner_user_id,
    folder,
    cli_scope: input.cli_scope ?? 'group',
    container_config: containerConfig,
    is_default: input.is_default,
  });

  saveAgentFiles(workspaceId, input.files);
  return { ...workspace, files: listAgentFiles(workspaceId) };
}

export function updateAgentMetadata(
  workspaceId: string,
  userId: string,
  input: { name?: string; container_config?: ContainerConfigSnapshot; cli_scope?: string; is_default?: boolean },
): GatewayAgent {
  assertAgentOwner(workspaceId, userId);
  const workspace = updateWorkspaceMetadata(workspaceId, input);
  return { ...workspace, files: listAgentFiles(workspaceId) };
}

export function updateAgentFilesRecord(
  workspaceId: string,
  userId: string,
  fileUpdates: GatewayAgentFile[],
): GatewayAgent {
  assertAgentOwner(workspaceId, userId);
  const merged = mergeAgentFiles(listAgentFiles(workspaceId), fileUpdates);
  saveAgentFiles(workspaceId, merged);
  const workspace = getWorkspace(workspaceId)!;
  return { ...workspace, files: merged };
}

export function getAgentFilesForPrepare(workspaceId: string): GatewayAgentFile[] {
  return listAgentFiles(workspaceId);
}

export type DeleteAgentResult = {
  agent: GatewayAgent;
  rebound_workspace_id: string | null;
  rebound_agent_name: string | null;
  conversations_rebound: number;
  conversations_cleared: number;
};

/** Remove a user-facing agent from the Gateway DB (files + workspace + chat bindings). */
export function deleteAgentRecord(workspaceId: string, userId: string): DeleteAgentResult {
  assertAgentOwner(workspaceId, userId);
  if (!isDeletableUserAgent(workspaceId)) {
    throw new AgentDeleteError('Internal builder/preview workspaces cannot be deleted this way');
  }

  const agent = getAgentForUser(workspaceId, userId);
  if (!agent) throw new AgentDeleteError('Agent not found', 404);

  const fallback = listAgentsForUser(userId)
    .filter((w) => w.workspace_id !== workspaceId && isDeletableUserAgent(w.workspace_id))
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    })[0];

  let conversationsRebound = 0;
  let conversationsCleared = 0;
  if (fallback) {
    conversationsRebound = rebindConversationsToWorkspace(workspaceId, fallback);
  } else {
    conversationsCleared = deleteConversationsForWorkspace(workspaceId);
  }

  deleteWorkspace(workspaceId);

  return {
    agent,
    rebound_workspace_id: fallback?.workspace_id ?? null,
    rebound_agent_name: fallback?.name ?? null,
    conversations_rebound: conversationsRebound,
    conversations_cleared: conversationsCleared,
  };
}

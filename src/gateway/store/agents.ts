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
  getWorkspace,
  listAgentsForUser,
  registerWorkspace,
  updateWorkspaceMetadata,
} from './workspaces.js';

export { listAgentsForUser, assertAgentOwner, defaultContainerConfig, mergeAgentFiles };

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

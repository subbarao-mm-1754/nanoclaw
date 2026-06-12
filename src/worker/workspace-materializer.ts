import fs from 'fs';
import path from 'path';

import { composeGroupClaudeMdAt } from '../claude-md-compose.js';
import {
  containerConfigFromSnapshot,
  materializeContainerJsonToDir,
  type ContainerConfig,
} from '../container-config.js';
import { syncSkillSymlinks } from '../skill-symlinks.js';
import { ensureClaudeSharedFilesystem } from '../group-init.js';
import { log } from '../log.js';
import type { WorkerAgentFile, WorkerWorkspaceManifest, WorkerWorkspacePaths } from './types.js';
import { workerWorkspacePaths } from './workspace-store.js';

export interface MaterializeWorkspaceResult extends WorkerWorkspacePaths {
  containerConfig: ContainerConfig;
  filesWritten: string[];
}

export function writeAgentFiles(groupDir: string, files: WorkerAgentFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    if (file.path.includes('..') || path.isAbsolute(file.path)) {
      throw new Error(`Invalid agent file path: ${file.path}`);
    }
    const normalized = file.path.replace(/\\/g, '/');
    const filePath = path.join(groupDir, normalized);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (Buffer.isBuffer(file.content)) {
      fs.writeFileSync(filePath, file.content);
    } else {
      fs.writeFileSync(filePath, file.content, 'utf8');
    }
    written.push(normalized);
  }
  return written;
}

/**
 * Materialize or refresh a worker workspace from manifest + optional file overrides.
 * Files are stored at the relative paths given in the request (e.g. CLAUDE.local.md, notes/foo.md).
 */
export function materializeWorkspace(
  manifest: WorkerWorkspaceManifest,
  files?: WorkerAgentFile[],
): MaterializeWorkspaceResult {
  const paths = workerWorkspacePaths(manifest.workspace_id);
  const { root: workspaceRoot, group_dir: groupDir, claude_shared_dir: claudeSharedDir } = paths;

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(claudeSharedDir, { recursive: true });

  const filesWritten = files?.length ? writeAgentFiles(groupDir, files) : [];

  ensureClaudeSharedFilesystem(claudeSharedDir);

  const agentGroup = {
    id: manifest.agent_group_id,
    name: manifest.name,
  };
  const containerConfig = containerConfigFromSnapshot(manifest.container_config, agentGroup);
  materializeContainerJsonToDir(groupDir, containerConfig);
  syncSkillSymlinks(claudeSharedDir, containerConfig);
  composeGroupClaudeMdAt({
    groupDir,
    mcpServers: containerConfig.mcpServers,
    cliScope: manifest.cli_scope,
  });

  log.info('Worker workspace materialized', {
    workspaceId: manifest.workspace_id,
    workspaceRoot,
    groupDir,
    filesWritten: filesWritten.length,
  });

  return {
    workspaceRoot,
    groupDir,
    claudeSharedDir,
    containerConfig,
    filesWritten,
  };
}

import fs from 'fs';
import path from 'path';

import { composeGroupClaudeMdAt } from '../claude-md-compose.js';
import {
  containerConfigFromSnapshot,
  materializeContainerJsonToDir,
  type ContainerConfig,
} from '../container-config.js';
import { syncSkillSymlinks } from '../skill-symlinks.js';
import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { WorkerJobRequest } from './types.js';

export interface MaterializeWorkspaceResult {
  workspaceRoot: string;
  groupDir: string;
  claudeSharedDir: string;
  containerConfig: ContainerConfig;
}

function writeAgentFiles(groupDir: string, files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    if (file.path.includes('..') || path.isAbsolute(file.path)) {
      throw new Error(`Invalid agent file path: ${file.path}`);
    }
    const filePath = path.join(groupDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }
}

/**
 * Materialize a per-job workspace from the gateway payload.
 * Layout mirrors spawn-time group dir + .claude-shared for Phase D mounts.
 */
export function materializeWorkspace(job: WorkerJobRequest): MaterializeWorkspaceResult {
  const workspaceRoot = path.join(DATA_DIR, 'worker-workspaces', job.job_id);
  const groupDir = path.join(workspaceRoot, 'agent');
  const claudeSharedDir = path.join(workspaceRoot, '.claude-shared');

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(claudeSharedDir, { recursive: true });

  const instructions = job.agent_snapshot.instructions ?? '';
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), instructions);

  if (job.agent_snapshot.files?.length) {
    writeAgentFiles(groupDir, job.agent_snapshot.files);
  }

  const agentGroup = {
    id: job.session.agent_group_id,
    name: job.agent_snapshot.name,
  };
  const containerConfig = containerConfigFromSnapshot(job.agent_snapshot.container_config, agentGroup);
  materializeContainerJsonToDir(groupDir, containerConfig);
  syncSkillSymlinks(claudeSharedDir, containerConfig);
  composeGroupClaudeMdAt({
    groupDir,
    mcpServers: containerConfig.mcpServers,
    cliScope: job.agent_snapshot.cli_scope ?? 'group',
  });

  log.info('Worker workspace materialized', {
    jobId: job.job_id,
    workspaceRoot,
    groupDir,
  });

  return { workspaceRoot, groupDir, claudeSharedDir, containerConfig };
}

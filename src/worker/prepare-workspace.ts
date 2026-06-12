import fs from 'fs';

import { log } from '../log.js';
import { materializeWorkspace } from './workspace-materializer.js';
import {
  saveWorkspaceManifest,
  workerWorkspaceRoot,
  workspaceExists,
} from './workspace-store.js';
import type { WorkerPrepareWorkspaceRequest, WorkerPrepareWorkspaceResponse } from './types.js';
import { WorkerValidationError } from './validate.js';

/**
 * Create or replace a worker workspace: write agent files at requested paths,
 * materialize container.json / CLAUDE.md, and persist a manifest for later jobs.
 */
export function runPrepareWorkspace(req: WorkerPrepareWorkspaceRequest): WorkerPrepareWorkspaceResponse {
  const exists = workspaceExists(req.workspace_id);
  if (exists && !req.options?.replace) {
    throw new WorkerValidationError(
      `Workspace already exists: ${req.workspace_id} (pass options.replace=true to overwrite)`,
    );
  }

  if (exists && req.options?.replace) {
    fs.rmSync(workerWorkspaceRoot(req.workspace_id), { recursive: true, force: true });
    log.info('Worker workspace replaced', { workspaceId: req.workspace_id });
  }

  const now = new Date().toISOString();
  const manifest = {
    workspace_id: req.workspace_id,
    agent_group_id: req.agent.agent_group_id,
    name: req.agent.name,
    folder: req.agent.folder ?? req.agent.agent_group_id,
    container_config: req.agent.container_config,
    cli_scope: req.agent.cli_scope ?? 'group',
    created_at: now,
    updated_at: now,
  };

  saveWorkspaceManifest(manifest);
  const materialized = materializeWorkspace(manifest, req.agent.files);

  log.info('Worker workspace prepared', {
    workspaceId: req.workspace_id,
    agentGroupId: req.agent.agent_group_id,
    fileCount: materialized.filesWritten.length,
  });

  return {
    workspace_id: req.workspace_id,
    status: 'prepared',
    workspace: {
      root: materialized.workspaceRoot,
      group_dir: materialized.groupDir,
      claude_shared_dir: materialized.claudeSharedDir,
    },
    files_written: materialized.filesWritten,
  };
}

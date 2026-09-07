import fs from 'fs';

import { log } from '../log.js';
import { materializeWorkspace } from './workspace-materializer.js';
import {
  saveWorkspaceManifest,
  workerWorkspaceRoot,
  workspaceExists,
  loadWorkspaceManifest,
} from './workspace-store.js';
import type { WorkerPrepareWorkspaceRequest, WorkerPrepareWorkspaceResponse } from './types.js';
import { WorkerValidationError } from './validate.js';

/**
 * Create, refresh, or replace a worker workspace: write agent files at requested
 * paths, materialize container.json / CLAUDE.md, and persist a manifest.
 *
 * Prefer `options.refresh` over `options.replace` when a container may still
 * have `/workspace/agent` mounted — replace deletes the mount root and breaks
 * the running container ("working dir was deleted").
 */
export function runPrepareWorkspace(req: WorkerPrepareWorkspaceRequest): WorkerPrepareWorkspaceResponse {
  const exists = workspaceExists(req.workspace_id);
  const replace = Boolean(req.options?.replace);
  const refresh = Boolean(req.options?.refresh);

  if (exists && !replace && !refresh) {
    throw new WorkerValidationError(
      `Workspace already exists: ${req.workspace_id} (pass options.replace=true or options.refresh=true)`,
    );
  }

  if (exists && replace) {
    fs.rmSync(workerWorkspaceRoot(req.workspace_id), { recursive: true, force: true });
    log.info('Worker workspace replaced', { workspaceId: req.workspace_id });
  } else if (exists && refresh) {
    log.info('Worker workspace refreshing in place', { workspaceId: req.workspace_id });
  }

  const now = new Date().toISOString();
  let createdAt = now;
  if (exists && !replace) {
    try {
      createdAt = loadWorkspaceManifest(req.workspace_id).created_at;
    } catch {
      // ignore
    }
  }
  const manifest = {
    workspace_id: req.workspace_id,
    agent_group_id: req.agent.agent_group_id,
    name: req.agent.name,
    folder: req.agent.folder ?? req.agent.agent_group_id,
    container_config: req.agent.container_config,
    cli_scope: req.agent.cli_scope ?? 'group',
    created_at: createdAt,
    updated_at: now,
  };

  saveWorkspaceManifest(manifest);
  const materialized = materializeWorkspace(manifest, req.agent.files);

  log.info('Worker workspace prepared', {
    workspaceId: req.workspace_id,
    agentGroupId: req.agent.agent_group_id,
    fileCount: materialized.filesWritten.length,
    refresh,
    replace,
  });

  return {
    workspace_id: req.workspace_id,
    status: 'prepared',
    workspace: {
      root: materialized.root,
      group_dir: materialized.group_dir,
      claude_shared_dir: materialized.claude_shared_dir,
    },
    files_written: materialized.filesWritten,
  };
}

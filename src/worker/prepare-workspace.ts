import fs from 'fs';

import { log } from '../log.js';
import { computeWorkspaceContentHash } from '../workspace-content-hash.js';
import { materializeWorkspace } from './workspace-materializer.js';
import {
  saveWorkspaceManifest,
  workerWorkspaceRoot,
  workerWorkspacePaths,
  workspaceExists,
  loadWorkspaceManifest,
} from './workspace-store.js';
import type { WorkerPrepareWorkspaceRequest, WorkerPrepareWorkspaceResponse } from './types.js';
import { WorkerValidationError } from './validate.js';

/**
 * Create, refresh, replace, or ensure a worker workspace: write agent files at
 * requested paths, materialize container.json / CLAUDE.md, and persist a manifest.
 *
 * Prefer `options.ensure` on the hot path (inbound messages): one call creates,
 * refreshes when content changed, or returns `unchanged` when the content hash
 * matches — no create→already-exists→refresh round-trip.
 *
 * Prefer `options.refresh` over `options.replace` when a container may still
 * have `/workspace/agent` mounted — replace deletes the mount root and breaks
 * the running container ("working dir was deleted").
 */
export function runPrepareWorkspace(req: WorkerPrepareWorkspaceRequest): WorkerPrepareWorkspaceResponse {
  const exists = workspaceExists(req.workspace_id);
  const replace = Boolean(req.options?.replace);
  const refresh = Boolean(req.options?.refresh);
  const ensure = Boolean(req.options?.ensure);

  if (exists && !replace && !refresh && !ensure) {
    throw new WorkerValidationError(
      `Workspace already exists: ${req.workspace_id} (pass options.ensure=true, options.refresh=true, or options.replace=true)`,
    );
  }

  const contentHash = computeWorkspaceContentHash({
    agent_group_id: req.agent.agent_group_id,
    name: req.agent.name,
    folder: req.agent.folder ?? req.agent.agent_group_id,
    cli_scope: req.agent.cli_scope ?? 'group',
    container_config: req.agent.container_config,
    files: req.agent.files,
  });

  if (exists && !replace && (ensure || refresh)) {
    try {
      const current = loadWorkspaceManifest(req.workspace_id);
      if (current.content_hash === contentHash) {
        // No disk work — stay quiet on the hot path.
        return {
          workspace_id: req.workspace_id,
          status: 'unchanged',
          workspace: workerWorkspacePaths(req.workspace_id),
          files_written: [],
          content_hash: contentHash,
        };
      }
    } catch {
      // Manifest unreadable — fall through and rematerialize.
    }
  }

  const action = !exists ? 'created' : replace ? 'replaced' : 'refreshed';
  if (exists && replace) {
    fs.rmSync(workerWorkspaceRoot(req.workspace_id), { recursive: true, force: true });
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
    content_hash: contentHash,
    created_at: createdAt,
    updated_at: now,
  };

  saveWorkspaceManifest(manifest);
  const materialized = materializeWorkspace(manifest, req.agent.files);

  log.info(`Worker workspace ${action}`, {
    workspaceId: req.workspace_id,
    agentGroupId: req.agent.agent_group_id,
    filesWritten: materialized.filesWritten.length,
    contentHash,
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
    content_hash: contentHash,
  };
}

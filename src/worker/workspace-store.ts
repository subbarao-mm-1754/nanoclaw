import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type { WorkerWorkspaceManifest, WorkerWorkspacePaths } from './types.js';
import { WorkerValidationError } from './validate.js';

const MANIFEST_FILE = 'workspace.json';

export function workerWorkspaceRoot(workspaceId: string): string {
  return path.join(DATA_DIR, 'worker-workspaces', workspaceId);
}

export function workerWorkspacePaths(workspaceId: string): WorkerWorkspacePaths {
  const root = workerWorkspaceRoot(workspaceId);
  return {
    root,
    group_dir: path.join(root, 'agent'),
    claude_shared_dir: path.join(root, '.claude-shared'),
  };
}

export function manifestPath(workspaceId: string): string {
  return path.join(workerWorkspaceRoot(workspaceId), MANIFEST_FILE);
}

export function workspaceExists(workspaceId: string): boolean {
  return fs.existsSync(manifestPath(workspaceId));
}

export function loadWorkspaceManifest(workspaceId: string): WorkerWorkspaceManifest {
  const p = manifestPath(workspaceId);
  if (!fs.existsSync(p)) {
    throw new WorkerValidationError(`Workspace not found: ${workspaceId}`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as WorkerWorkspaceManifest;
  } catch {
    throw new WorkerValidationError(`Workspace manifest is invalid: ${workspaceId}`);
  }
}

export function saveWorkspaceManifest(manifest: WorkerWorkspaceManifest): void {
  const root = workerWorkspaceRoot(manifest.workspace_id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

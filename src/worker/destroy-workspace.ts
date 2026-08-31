import fs from 'fs';

import { killContainer } from '../container-runner.js';
import { log } from '../log.js';
import { workerWorkspaceRoot, workspaceExists } from './workspace-store.js';
import type { WorkerDestroyWorkspaceResponse } from './types.js';
import { WorkerValidationError } from './validate.js';

/**
 * Stop any active container for the session and delete the worker workspace
 * directory. Used when a builder job completes so memory/disk are freed.
 */
export function runDestroyWorkspace(input: {
  workspace_id: string;
  session_id?: string;
}): WorkerDestroyWorkspaceResponse {
  let containerKilled = false;

  if (input.session_id) {
    killContainer(input.session_id, 'workspace destroy');
    containerKilled = true;
    log.info('Worker destroy requested container kill', {
      workspaceId: input.workspace_id,
      sessionId: input.session_id,
    });
  }

  if (!workspaceExists(input.workspace_id)) {
    // Idempotent: already gone is success (container may still have been killed).
    return {
      workspace_id: input.workspace_id,
      status: 'destroyed',
      container_killed: containerKilled,
    };
  }

  const root = workerWorkspaceRoot(input.workspace_id);
  // Safety: only delete under worker-workspaces/
  if (!root.includes('worker-workspaces')) {
    throw new WorkerValidationError(`Refusing to destroy unexpected path for ${input.workspace_id}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  log.info('Worker workspace destroyed', { workspaceId: input.workspace_id });

  return {
    workspace_id: input.workspace_id,
    status: 'destroyed',
    container_killed: containerKilled,
  };
}

import fs from 'fs';
import path from 'path';

import { stopContainerSession } from '../container-runner.js';
import { log } from '../log.js';
import { stopSessionCollector } from './outbound-collector.js';
import { workerWorkspaceRoot } from './workspace-store.js';

/**
 * Drop Claude's sticky remote-MCP needs-auth skip file for a worker workspace.
 * Safe no-op when missing. Does not touch sessions, settings, or transcripts.
 */
export function clearWorkspaceMcpNeedsAuthCache(workspaceId: string): void {
  const file = path.join(
    workerWorkspaceRoot(workspaceId),
    '.claude-shared',
    'mcp-needs-auth-cache.json',
  );
  try {
    if (!fs.existsSync(file)) return;
    fs.unlinkSync(file);
    log.info('Cleared workspace MCP needs-auth cache', { workspaceId });
  } catch (err) {
    log.warn('Failed to clear workspace MCP needs-auth cache', { workspaceId, err });
  }
}

/**
 * Stop agent containers for the given sessions without deleting workspace disk.
 * Scoped for MCP reconnect after Gateway OAuth — conversation DBs and
 * continuation ids stay intact for the next wake.
 */
export async function runStopContainers(input: {
  workspace_id?: string;
  session_ids: string[];
  reason?: string;
}): Promise<{ stopped: string[]; skipped: string[] }> {
  const reason = input.reason?.trim() || 'mcp-auth-reconnect';
  const stopped: string[] = [];
  const skipped: string[] = [];

  if (input.workspace_id) {
    clearWorkspaceMcpNeedsAuthCache(input.workspace_id);
  }

  const unique = [...new Set(input.session_ids.map((id) => id.trim()).filter(Boolean))];
  for (const sessionId of unique) {
    stopSessionCollector(sessionId, reason);
    const wasRunning = await stopContainerSession(sessionId, reason);
    if (wasRunning) {
      stopped.push(sessionId);
      log.info('Stopped session container for MCP reconnect', {
        sessionId,
        workspaceId: input.workspace_id ?? null,
        reason,
      });
    } else {
      skipped.push(sessionId);
    }
  }

  return { stopped, skipped };
}

import { LIVE_BROWSER_ENABLED, LIVE_BROWSER_STREAM_PORT } from '../../config.js';
import { log } from '../../log.js';
import { registerEndpoint, unregisterEndpoint, type LiveBrowserEndpoint } from './registry.js';

export interface LiveBrowserSpawnMeta {
  containerPort: number;
  workspaceId: string | null;
}

/** Wrapper that auto-pins stream after `open` (see container/skills/agent-browser/bin). */
const LIVE_BROWSER_WRAPPER_DIR = '/app/skills/agent-browser/bin';

/**
 * Append container env for a fixed agent-browser stream port.
 * No host `-p` publish — stream binds 127.0.0.1 inside the container and is
 * reached via docker exec relay (see container-relay.ts).
 *
 * Also prepends a PATH wrapper so `agent-browser open` auto-pins the stream
 * **without** `stream disable` (disable was wiping the page to about:blank).
 */
export function applyLiveBrowserContainerArgs(args: string[]): LiveBrowserSpawnMeta | null {
  if (!LIVE_BROWSER_ENABLED) return null;

  const containerPort = LIVE_BROWSER_STREAM_PORT;
  args.push('-e', `AGENT_BROWSER_STREAM_PORT=${containerPort}`);
  args.push('-e', 'AGENT_BROWSER_REAL_BIN=/pnpm/agent-browser');
  // Image PATH is /pnpm:... — put the auto-pin wrapper first.
  args.push(
    '-e',
    `PATH=${LIVE_BROWSER_WRAPPER_DIR}:/pnpm:/pnpm/global/5/bin:/usr/local/bin:/usr/bin:/bin`,
  );
  return { containerPort, workspaceId: null };
}

export function registerLiveBrowserEndpoint(input: {
  sessionId: string;
  workspaceId?: string | null;
  agentGroupId: string;
  containerName: string;
  containerPort: number;
}): LiveBrowserEndpoint {
  const ep: LiveBrowserEndpoint = {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    agentGroupId: input.agentGroupId,
    containerName: input.containerName,
    containerPort: input.containerPort,
    control: 'agent',
    registeredAt: Date.now(),
  };
  registerEndpoint(ep);
  log.info('Live browser endpoint registered', {
    sessionId: ep.sessionId,
    workspaceId: ep.workspaceId,
    containerName: ep.containerName,
    containerPort: ep.containerPort,
  });
  return ep;
}

export function unregisterLiveBrowserEndpoint(sessionId: string): void {
  const ep = unregisterEndpoint(sessionId);
  if (ep) {
    log.info('Live browser endpoint unregistered', {
      sessionId,
      containerName: ep.containerName,
    });
  }
}

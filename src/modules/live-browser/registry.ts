/**
 * In-memory map of running containers with live-browser stream support.
 * Stream is reached via docker exec relay (agent-browser binds 127.0.0.1 only).
 */
export interface LiveBrowserEndpoint {
  sessionId: string;
  workspaceId: string | null;
  agentGroupId: string;
  containerName: string;
  /** agent-browser stream port inside the container (127.0.0.1). */
  containerPort: number;
  /** agent-browser CLI session name (each session has its own stream port). */
  browserSession?: string | null;
  /** Last known page URL from agent-browser get url / discovery. */
  pageUrl?: string | null;
  /** human | agent — who should drive the browser. */
  control: 'agent' | 'human';
  registeredAt: number;
}

const bySession = new Map<string, LiveBrowserEndpoint>();
const byWorkspace = new Map<string, string>(); // workspaceId → sessionId

export function registerEndpoint(ep: LiveBrowserEndpoint): void {
  const prev = bySession.get(ep.sessionId);
  if (prev?.workspaceId) byWorkspace.delete(prev.workspaceId);
  bySession.set(ep.sessionId, ep);
  if (ep.workspaceId) {
    byWorkspace.set(ep.workspaceId, ep.sessionId);
  }
}

export function unregisterEndpoint(sessionId: string): LiveBrowserEndpoint | undefined {
  const ep = bySession.get(sessionId);
  if (!ep) return undefined;
  bySession.delete(sessionId);
  if (ep.workspaceId && byWorkspace.get(ep.workspaceId) === sessionId) {
    byWorkspace.delete(ep.workspaceId);
  }
  return ep;
}

export function getLiveBrowserBySession(sessionId: string): LiveBrowserEndpoint | undefined {
  return bySession.get(sessionId);
}

export function getLiveBrowserByWorkspace(workspaceId: string): LiveBrowserEndpoint | undefined {
  const sessionId = byWorkspace.get(workspaceId);
  return sessionId ? bySession.get(sessionId) : undefined;
}

export function listLiveBrowserEndpoints(): LiveBrowserEndpoint[] {
  return [...bySession.values()];
}

export function setControl(sessionId: string, control: 'agent' | 'human'): LiveBrowserEndpoint | undefined {
  const ep = bySession.get(sessionId);
  if (!ep) return undefined;
  ep.control = control;
  return ep;
}

/** Test helper — wipe registry. */
export function resetLiveBrowserRegistryForTests(): void {
  bySession.clear();
  byWorkspace.clear();
}

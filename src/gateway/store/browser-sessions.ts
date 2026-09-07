/**
 * Gateway-stored browser sessions (agent-browser storageState JSON).
 *
 * Secrets live in `auth_json` for now (same trust boundary as OAuth refresh
 * tokens). Call sites should treat vault migration as swapping this column
 * for a vault reference later — public metadata APIs never return auth_json
 * unless explicitly requested.
 */
import { generateId } from '../auth.js';
import { getGatewayDb } from '../db/connection.js';
import { sanitizeStorageStateForOrigin } from '../browser-session-sanitize.js';
import type { GatewayAgentFile } from '../types.js';
import { AgentAccessError, assertAgentOwner } from './agent-files.js';

export type BrowserSessionStatus = 'pending' | 'active' | 'expired' | 'revoked';

export interface BrowserSession {
  id: string;
  user_id: string;
  label: string;
  origin: string | null;
  status: BrowserSessionStatus;
  auth_json: string;
  metadata_json: string | null;
  connect_token: string | null;
  connect_expires_at: string | null;
  login_url: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Safe for API responses — omits auth_json. */
export interface BrowserSessionPublic {
  id: string;
  user_id: string;
  label: string;
  origin: string | null;
  status: BrowserSessionStatus;
  metadata_json: string | null;
  login_url: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  has_auth: boolean;
}

const BROWSER_SESSIONS_DIR = 'browser-sessions';

function now(): string {
  return new Date().toISOString();
}

function mapRow(row: Record<string, unknown>): BrowserSession {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    label: row.label as string,
    origin: (row.origin as string | null) ?? null,
    status: row.status as BrowserSessionStatus,
    auth_json: row.auth_json as string,
    metadata_json: (row.metadata_json as string | null) ?? null,
    connect_token: (row.connect_token as string | null) ?? null,
    connect_expires_at: (row.connect_expires_at as string | null) ?? null,
    login_url: (row.login_url as string | null) ?? null,
    last_used_at: (row.last_used_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function toPublicBrowserSession(session: BrowserSession): BrowserSessionPublic {
  return {
    id: session.id,
    user_id: session.user_id,
    label: session.label,
    origin: session.origin,
    status: session.status,
    metadata_json: session.metadata_json,
    login_url: session.login_url,
    last_used_at: session.last_used_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    has_auth: Boolean(session.auth_json && session.auth_json !== '{}'),
  };
}

export function browserSessionFilePath(sessionId: string): string {
  return `${BROWSER_SESSIONS_DIR}/${sessionId}.json`;
}

/** Validate agent-browser / Playwright storageState JSON. */
export function normalizeAuthJson(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('auth_json must not be empty');
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('auth_json must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('auth_json must be a JSON object');
    }
    return JSON.stringify(parsed);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }
  throw new Error('auth_json must be a JSON object or JSON string');
}

export function createBrowserSession(input: {
  user_id: string;
  label: string;
  origin?: string | null;
  auth_json: unknown;
  metadata_json?: string | null;
}): BrowserSession {
  const label = input.label.trim();
  if (!label) throw new Error('label is required');

  const authJson = normalizeAuthJson(input.auth_json);
  const id = generateId('bs');
  const ts = now();
  const origin = input.origin?.trim() || null;

  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_browser_sessions (
         id, user_id, label, origin, status, auth_json, metadata_json,
         last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
    )
    .run(id, input.user_id, label, origin, authJson, input.metadata_json ?? null, ts, ts);

  return getBrowserSession(id)!;
}

export function createPendingBrowserSession(input: {
  user_id: string;
  label: string;
  origin: string;
  login_url: string;
  connect_token: string;
  connect_expires_at: string;
  metadata_json?: string | null;
}): BrowserSession {
  const label = input.label.trim();
  if (!label) throw new Error('label is required');
  const id = generateId('bs');
  const ts = now();

  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_browser_sessions (
         id, user_id, label, origin, status, auth_json, metadata_json,
         connect_token, connect_expires_at, login_url,
         last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', '{}', ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.user_id,
      label,
      input.origin,
      input.metadata_json ?? null,
      input.connect_token,
      input.connect_expires_at,
      input.login_url,
      ts,
      ts,
    );

  return getBrowserSession(id)!;
}

export function getBrowserSessionByConnectToken(token: string): BrowserSession | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_browser_sessions WHERE connect_token = ?')
    .get(token) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function findActiveBrowserSessionForOrigin(
  userId: string,
  origin: string,
): BrowserSession | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_browser_sessions
       WHERE user_id = ? AND status = 'active' AND origin = ?
         AND auth_json != '{}'
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(userId, origin) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function activatePendingBrowserSession(
  id: string,
  authJson: string,
  opts?: { forceExpire?: boolean },
): BrowserSession {
  const ts = now();
  if (opts?.forceExpire) {
    getGatewayDb()
      .prepare(
        `UPDATE gateway_browser_sessions
         SET status = 'expired', auth_json = '{}', connect_token = NULL,
             connect_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(ts, id);
    return getBrowserSession(id)!;
  }

  getGatewayDb()
    .prepare(
      `UPDATE gateway_browser_sessions
       SET status = 'active', auth_json = ?, connect_token = NULL,
           connect_expires_at = NULL, updated_at = ?, last_used_at = ?
       WHERE id = ?`,
    )
    .run(authJson, ts, ts, id);

  return getBrowserSession(id)!;
}

export function expirePendingBrowserSession(id: string): void {
  activatePendingBrowserSession(id, '{}', { forceExpire: true });
}

export function getBrowserSession(id: string): BrowserSession | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM gateway_browser_sessions WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function listBrowserSessionsForUser(userId: string): BrowserSession[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT * FROM gateway_browser_sessions
       WHERE user_id = ? AND status != 'revoked'
       ORDER BY updated_at DESC`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export function updateBrowserSessionAuth(
  id: string,
  userId: string,
  authJsonRaw: unknown,
): BrowserSession {
  const existing = getBrowserSession(id);
  if (!existing || existing.user_id !== userId) {
    throw new AgentAccessError('Browser session not found', 404);
  }
  if (existing.status === 'revoked') {
    throw new AgentAccessError('Browser session is revoked', 400);
  }

  const authJson = normalizeAuthJson(authJsonRaw);
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE gateway_browser_sessions
       SET auth_json = ?, status = 'active', updated_at = ?, last_used_at = ?
       WHERE id = ?`,
    )
    .run(authJson, ts, ts, id);

  return getBrowserSession(id)!;
}

export function updateBrowserSessionMeta(
  id: string,
  userId: string,
  input: { label?: string; origin?: string | null; status?: BrowserSessionStatus },
): BrowserSession {
  const existing = getBrowserSession(id);
  if (!existing || existing.user_id !== userId) {
    throw new AgentAccessError('Browser session not found', 404);
  }

  const label = input.label !== undefined ? input.label.trim() : existing.label;
  if (!label) throw new Error('label is required');
  const origin =
    input.origin !== undefined ? input.origin?.trim() || null : existing.origin;
  const status = input.status ?? existing.status;
  const ts = now();

  getGatewayDb()
    .prepare(
      `UPDATE gateway_browser_sessions
       SET label = ?, origin = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(label, origin, status, ts, id);

  return getBrowserSession(id)!;
}

export function revokeBrowserSession(id: string, userId: string): void {
  const existing = getBrowserSession(id);
  if (!existing || existing.user_id !== userId) {
    throw new AgentAccessError('Browser session not found', 404);
  }
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE gateway_browser_sessions
       SET status = 'revoked', auth_json = '{}', updated_at = ?
       WHERE id = ?`,
    )
    .run(ts, id);
  getGatewayDb()
    .prepare('DELETE FROM gateway_workspace_browser_sessions WHERE session_id = ?')
    .run(id);
}

export function bindBrowserSessionToWorkspace(
  workspaceId: string,
  sessionId: string,
  userId: string,
): BrowserSession {
  assertAgentOwner(workspaceId, userId);
  const session = getBrowserSession(sessionId);
  if (!session || session.user_id !== userId) {
    throw new AgentAccessError('Browser session not found', 404);
  }
  if (session.status !== 'active') {
    throw new AgentAccessError('Only active browser sessions can be bound', 400);
  }

  const ts = now();
  getGatewayDb()
    .prepare(
      `INSERT INTO gateway_workspace_browser_sessions (workspace_id, session_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, session_id) DO NOTHING`,
    )
    .run(workspaceId, sessionId, ts);

  return session;
}

export function unbindBrowserSessionFromWorkspace(
  workspaceId: string,
  sessionId: string,
  userId: string,
): void {
  assertAgentOwner(workspaceId, userId);
  getGatewayDb()
    .prepare(
      `DELETE FROM gateway_workspace_browser_sessions
       WHERE workspace_id = ? AND session_id = ?`,
    )
    .run(workspaceId, sessionId);
}

export function listBrowserSessionsForWorkspace(workspaceId: string, userId: string): BrowserSession[] {
  assertAgentOwner(workspaceId, userId);
  const rows = getGatewayDb()
    .prepare(
      `SELECT s.* FROM gateway_browser_sessions s
       INNER JOIN gateway_workspace_browser_sessions b
         ON b.session_id = s.id
       WHERE b.workspace_id = ? AND s.status = 'active'
       ORDER BY s.label COLLATE NOCASE`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Bound active sessions for prepare injection (no owner check — internal). */
export function listBoundBrowserSessions(workspaceId: string): BrowserSession[] {
  const rows = getGatewayDb()
    .prepare(
      `SELECT s.* FROM gateway_browser_sessions s
       INNER JOIN gateway_workspace_browser_sessions b
         ON b.session_id = s.id
       WHERE b.workspace_id = ? AND s.status = 'active'
       ORDER BY s.label COLLATE NOCASE`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/**
 * Materialize bound sessions as agent workspace files for the container.
 * Paths: browser-sessions/<id>.json + browser-sessions/index.json
 */
export function browserSessionFilesForWorkspace(workspaceId: string): GatewayAgentFile[] {
  const sessions = listBoundBrowserSessions(workspaceId);
  if (sessions.length === 0) return [];

  const files: GatewayAgentFile[] = [];
  const index = {
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label,
      origin: s.origin,
      file: browserSessionFilePath(s.id),
    })),
  };
  files.push({
    path: `${BROWSER_SESSIONS_DIR}/index.json`,
    content: `${JSON.stringify(index, null, 2)}\n`,
  });

  for (const session of sessions) {
    files.push({
      path: browserSessionFilePath(session.id),
      content: session.auth_json,
    });
  }

  return files;
}

/** Merge browser session files over agent files (browser paths win). */
export function mergeFilesWithBrowserSessions(
  workspaceId: string,
  files: GatewayAgentFile[],
): GatewayAgentFile[] {
  const browserFiles = browserSessionFilesForWorkspace(workspaceId);
  if (browserFiles.length === 0) return files;

  const byPath = new Map<string, GatewayAgentFile>();
  for (const f of files) byPath.set(f.path.replace(/\\/g, '/'), f);
  for (const f of browserFiles) byPath.set(f.path, f);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Persist auth_json updates from a worker memory_patch when the agent
 * re-saves browser-sessions/<id>.json after browsing.
 */
export function captureBrowserSessionsFromMemoryPatch(
  workspaceId: string,
  patch: { files?: Array<{ path: string; content: string; deleted?: boolean }> },
): number {
  if (!patch.files?.length) return 0;

  let updated = 0;
  const bound = new Map(listBoundBrowserSessions(workspaceId).map((s) => [s.id, s]));
  const ts = now();

  for (const file of patch.files) {
    if (file.deleted) continue;
    const rel = file.path.replace(/\\/g, '/');
    const match = rel.match(/^browser-sessions\/(bs-[a-f0-9]+)\.json$/i);
    if (!match) continue;
    const sessionId = match[1]!;
    const session = bound.get(sessionId) ?? getBrowserSession(sessionId);
    if (!session || session.status === 'revoked') continue;

    // Only capture if bound to this workspace (or still owned via bind list).
    if (!bound.has(sessionId)) continue;

    try {
      const raw = normalizeAuthJson(file.content);
      const authJson = session.origin
        ? sanitizeStorageStateForOrigin(session.origin, raw)
        : raw;
      getGatewayDb()
        .prepare(
          `UPDATE gateway_browser_sessions
           SET auth_json = ?, status = 'active', updated_at = ?, last_used_at = ?
           WHERE id = ?`,
        )
        .run(authJson, ts, ts, sessionId);
      updated += 1;
    } catch {
      // Ignore invalid JSON in patch — do not wipe stored session.
    }
  }

  return updated;
}

export function touchBrowserSession(sessionId: string): void {
  const ts = now();
  getGatewayDb()
    .prepare(
      `UPDATE gateway_browser_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(ts, ts, sessionId);
}

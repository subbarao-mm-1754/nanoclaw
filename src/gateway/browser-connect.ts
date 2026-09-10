/**
 * Browser session connect orchestration:
 *   agent/API request → open headed Chrome → Cliq notify → user confirms →
 *   sanitize cookies → store + bind → refresh worker → reply to agent.
 */
import { randomBytes } from 'crypto';

import { GATEWAY_PUBLIC_URL } from '../config.js';
import { log } from '../log.js';
import { generateId } from './auth.js';
import { ensureWorkspaceOnWorker } from './agent-service.js';
import {
  closeLiveCapture,
  openHeadedLogin,
  readStorageState,
} from './browser-capture.js';
import { sanitizeStorageStateForOrigin } from './browser-session-sanitize.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import {
  activatePendingBrowserSession,
  bindBrowserSessionToWorkspace,
  createPendingBrowserSession,
  expirePendingBrowserSession,
  findActiveBrowserSessionForOrigin,
  getBrowserSession,
  getBrowserSessionByConnectToken,
  revokeBrowserSession,
  toPublicBrowserSession,
  type BrowserSession,
} from './store/browser-sessions.js';
import { findConversation } from './store/conversations.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getWorkspace } from './store/workspaces.js';
import { AgentAccessError, assertAgentOwner } from './store/agent-files.js';

const CONNECT_TTL_MS = 15 * 60 * 1000;

export class BrowserConnectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'BrowserConnectError';
  }
}

function nowMs(): number {
  return Date.now();
}

function connectUrl(token: string): string {
  return `${GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/v1/browser-sessions/connect/${encodeURIComponent(token)}`;
}

function newConnectToken(): string {
  return randomBytes(24).toString('base64url');
}

function normalizeOrigin(origin: string): string {
  const u = new URL(origin.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BrowserConnectError('origin must be http(s)');
  }
  u.hash = '';
  u.search = '';
  // Drop trailing slash except root
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  if (u.pathname === '/') u.pathname = '';
  return u.origin;
}

async function notifyChannel(
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
): Promise<void> {
  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    log.warn('No channel adapter for browser-session notify', { channelType });
    return;
  }
  await adapter.deliver(platformId, threadId, {
    kind: 'chat',
    content: { text },
  });
}

export async function startBrowserConnect(input: {
  userId: string;
  origin: string;
  label?: string;
  loginUrl?: string;
  workspaceId?: string | null;
  /**
   * When true, skip reusing an existing active session and open a headed login
   * even if cookies are already stored. Agent MCP requests use this when the
   * site shows logged-out / session expired (stale cookies still look "active").
   */
  force?: boolean;
  notify?: {
    channel_type: string;
    platform_id: string;
    thread_id: string | null;
  } | null;
}): Promise<{
  reused: boolean;
  session: ReturnType<typeof toPublicBrowserSession>;
  connect_url: string | null;
  message: string;
}> {
  const origin = normalizeOrigin(input.origin);
  if (input.workspaceId) {
    assertAgentOwner(input.workspaceId, input.userId);
  }

  const existing = findActiveBrowserSessionForOrigin(input.userId, origin);
  if (existing && !input.force) {
    if (input.workspaceId) {
      bindBrowserSessionToWorkspace(input.workspaceId, existing.id, input.userId);
      try {
        await ensureWorkspaceOnWorker(input.workspaceId);
      } catch (err) {
        log.warn('Failed refreshing workspace after reusing browser session', {
          workspaceId: input.workspaceId,
          err,
        });
      }
    }
    if (input.notify) {
      await notifyChannel(
        input.notify.channel_type,
        input.notify.platform_id,
        input.notify.thread_id,
        [
          `Browser session for ${origin} is already available.`,
          'You can continue — the agent can use the saved login.',
        ].join('\n'),
      );
    }
    return {
      reused: true,
      session: toPublicBrowserSession(existing),
      connect_url: null,
      message: 'Existing browser session reused.',
    };
  }

  if (existing && input.force) {
    // Stale cookies still sit in status=active; revoke so the agent gets a real login.
    log.info('Forcing new browser login; revoking existing session for origin', {
      userId: input.userId,
      origin,
      sessionId: existing.id,
    });
    revokeBrowserSession(existing.id, input.userId);
    if (input.workspaceId) {
      try {
        await ensureWorkspaceOnWorker(input.workspaceId);
      } catch (err) {
        log.warn('Failed refreshing workspace after revoking stale browser session', {
          workspaceId: input.workspaceId,
          err,
        });
      }
    }
  }

  const token = newConnectToken();
  const expiresAt = new Date(nowMs() + CONNECT_TTL_MS).toISOString();
  const loginUrl = (input.loginUrl?.trim() || origin).trim();
  const label = (input.label?.trim() || new URL(origin).hostname).trim();

  const session = createPendingBrowserSession({
    user_id: input.userId,
    label,
    origin,
    login_url: loginUrl,
    connect_token: token,
    connect_expires_at: expiresAt,
    metadata_json: JSON.stringify({
      workspace_id: input.workspaceId ?? null,
      notify: input.notify ?? null,
    }),
  });

  try {
    await openHeadedLogin({
      sessionId: session.id,
      connectToken: token,
      origin,
      loginUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expirePendingBrowserSession(session.id);
    await closeLiveCapture(session.id);
    throw new BrowserConnectError(
      `Could not open a headed browser on the gateway host: ${message}`,
      503,
    );
  }

  const url = connectUrl(token);
  if (input.notify) {
    await notifyChannel(
      input.notify.channel_type,
      input.notify.platform_id,
      input.notify.thread_id,
      [
        `Browser login needed for ${origin}.`,
        '',
        'A browser window opened on the NanoClaw gateway machine — log in there.',
        'When you are logged in, open this link and click **I\'ve finished logging in**:',
        url,
        '',
        `This link expires in ${Math.round(CONNECT_TTL_MS / 60000)} minutes.`,
      ].join('\n'),
    );
  }

  return {
    reused: false,
    session: toPublicBrowserSession(session),
    connect_url: url,
    message: 'Headed browser opened. Confirm after login.',
  };
}

export async function confirmBrowserConnect(token: string): Promise<{
  session: ReturnType<typeof toPublicBrowserSession>;
  workspace_id: string | null;
}> {
  const session = getBrowserSessionByConnectToken(token);
  if (!session) {
    throw new BrowserConnectError('Invalid or expired connect link', 404);
  }
  if (session.status === 'active' && session.auth_json !== '{}') {
    return { session: toPublicBrowserSession(session), workspace_id: workspaceIdFromMeta(session) };
  }
  if (session.status !== 'pending') {
    throw new BrowserConnectError('This connect link is no longer pending', 400);
  }
  if (session.connect_expires_at && Date.parse(session.connect_expires_at) <= nowMs()) {
    await closeLiveCapture(session.id);
    throw new BrowserConnectError('Connect link expired — ask the agent to request login again', 410);
  }
  if (!session.origin) {
    throw new BrowserConnectError('Session is missing origin', 400);
  }

  let rawState: unknown;
  try {
    rawState = await readStorageState(session.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BrowserConnectError(
      `Browser window is not available (${message}). Ask the agent to start login again.`,
      409,
    );
  }

  let sanitized: string;
  try {
    sanitized = sanitizeStorageStateForOrigin(session.origin, rawState);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BrowserConnectError(message, 400);
  }

  const activated = activatePendingBrowserSession(session.id, sanitized);
  await closeLiveCapture(session.id);

  const workspaceId = workspaceIdFromMeta(activated);
  if (workspaceId) {
    try {
      bindBrowserSessionToWorkspace(workspaceId, activated.id, activated.user_id);
      await ensureWorkspaceOnWorker(workspaceId);
    } catch (err) {
      log.warn('Failed bind/refresh after browser connect confirm', { workspaceId, err });
    }
  }

  const notify = notifyFromMeta(activated);
  if (notify) {
    await notifyChannel(
      notify.channel_type,
      notify.platform_id,
      notify.thread_id,
      [
        `Browser session saved for ${activated.origin}.`,
        'Only site cookies were stored (no password). You can continue in this chat — the agent will use the saved session.',
      ].join('\n'),
    );

    // Wake the agent with an explicit system-style inbound so it does not
    // reuse stale connect links from earlier turns.
    try {
      const conv = findConversation(notify.channel_type, notify.platform_id, notify.thread_id);
      if (conv) {
        const file = `browser-sessions/${activated.id}.json`;
        const ts = new Date().toISOString();
        enqueueInboundMessage(
          {
            id: generateId('msg'),
            channel_type: notify.channel_type,
            platform_id: notify.platform_id,
            thread_id: notify.thread_id,
            kind: 'chat',
            content: {
              text: [
                `[browser-session-ready] Login completed for ${activated.origin}.`,
                `Session id: ${activated.id}`,
                `Load with: agent-browser state load ${file}`,
                'Then continue the user\'s previous request. Do NOT send old connect URLs. Do NOT call request_browser_session again for this origin unless browsing still shows logged-out.',
              ].join('\n'),
            },
            sender_id: 'system:browser-session',
            sender_display_name: 'Browser session',
            timestamp: ts,
          },
          conv.id,
        );
      }
    } catch (err) {
      log.warn('Failed to enqueue browser-session-ready inbound', { err });
    }
  }

  return { session: toPublicBrowserSession(activated), workspace_id: workspaceId };
}

function workspaceIdFromMeta(session: BrowserSession): string | null {
  if (!session.metadata_json) return null;
  try {
    const meta = JSON.parse(session.metadata_json) as { workspace_id?: string | null };
    return typeof meta.workspace_id === 'string' ? meta.workspace_id : null;
  } catch {
    return null;
  }
}

function notifyFromMeta(session: BrowserSession): {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
} | null {
  if (!session.metadata_json) return null;
  try {
    const meta = JSON.parse(session.metadata_json) as {
      notify?: { channel_type?: string; platform_id?: string; thread_id?: string | null } | null;
    };
    const n = meta.notify;
    if (!n?.channel_type || !n.platform_id) return null;
    return {
      channel_type: n.channel_type,
      platform_id: n.platform_id,
      thread_id: n.thread_id ?? null,
    };
  } catch {
    return null;
  }
}

export function connectPageHtml(token: string, session: BrowserSession | null): string {
  const origin = session?.origin ?? 'the site';
  const expired =
    session?.connect_expires_at != null && Date.parse(session.connect_expires_at) <= nowMs();
  const ready = session?.status === 'active';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browser session connect</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.45; }
    button { font-size: 1rem; padding: 0.6rem 1rem; cursor: pointer; }
    .ok { color: #0a7; }
    .err { color: #c33; }
  </style>
</head>
<body>
  <h1>Browser login</h1>
  <p>Log in to <strong>${escapeHtml(origin)}</strong> in the browser window on the gateway machine.</p>
  ${
    ready
      ? `<p class="ok">Session already saved. You can return to Cliq and continue.</p>`
      : expired
        ? `<p class="err">This link expired. Ask the agent to request a browser session again.</p>`
        : `<p>When you are fully logged in, click below. NanoClaw stores only cookies for this site (no password, no unrelated cookies).</p>
  <button id="done" type="button">I've finished logging in</button>
  <p id="status"></p>
  <script>
    const status = document.getElementById('status');
    document.getElementById('done').onclick = async () => {
      status.textContent = 'Capturing session…';
      try {
        const res = await fetch(${JSON.stringify(`/v1/browser-sessions/connect/${token}/confirm`)}, { method: 'POST' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        status.className = 'ok';
        status.textContent = 'Saved. Return to Cliq and tell the agent to continue.';
      } catch (e) {
        status.className = 'err';
        status.textContent = e instanceof Error ? e.message : String(e);
      }
    };
  </script>`
  }
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Internal worker entry: resolve workspace owner and start connect. */
export async function handleBrowserSessionRequest(input: {
  workspace_id: string;
  origin: string;
  label?: string;
  login_url?: string;
  /** Default true — agent only asks when login is needed. */
  force?: boolean;
  notify?: {
    channel_type: string;
    platform_id: string;
    thread_id: string | null;
  } | null;
}): Promise<{
  ok: boolean;
  reused?: boolean;
  session_id?: string;
  connect_url?: string | null;
  message?: string;
  error?: string;
}> {
  const workspace = getWorkspace(input.workspace_id);
  if (!workspace?.owner_user_id) {
    return { ok: false, error: 'Workspace not found or has no owner' };
  }
  try {
    const result = await startBrowserConnect({
      userId: workspace.owner_user_id,
      origin: input.origin,
      label: input.label,
      loginUrl: input.login_url,
      workspaceId: input.workspace_id,
      // Agent MCP path: always open headed login unless explicitly told to reuse.
      force: input.force !== false,
      notify: input.notify ?? null,
    });
    return {
      ok: true,
      reused: result.reused,
      session_id: result.session.id,
      connect_url: result.connect_url,
      message: result.message,
    };
  } catch (err) {
    if (err instanceof BrowserConnectError || err instanceof AgentAccessError) {
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function getBrowserSessionForConnectPage(token: string): BrowserSession | null {
  return getBrowserSessionByConnectToken(token);
}

export async function abandonPendingSession(sessionId: string): Promise<void> {
  const s = getBrowserSession(sessionId);
  if (!s || s.status !== 'pending') return;
  await closeLiveCapture(sessionId);
  expirePendingBrowserSession(sessionId);
}

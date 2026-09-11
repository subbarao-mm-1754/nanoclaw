/**
 * request_browser_session — ask the gateway to open a headed login browser
 * and notify the user (e.g. Cliq). Never collect passwords in chat.
 */
import { findBrowserSessionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `browser-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrowserSessionResponse(
  requestId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findBrowserSessionResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        const parsed = JSON.parse(response.content) as Record<string, unknown>;
        if (parsed.type !== 'browser_session_response') continue;
        if (!parsed.ok) {
          return {
            ok: false,
            error: typeof parsed.error === 'string' ? parsed.error : 'Request failed',
          };
        }
        return { ok: true, data: parsed };
      } catch {
        return { ok: false, error: 'Invalid browser_session_response JSON' };
      }
    }
    await sleep(250);
  }
  return {
    ok: false,
    error:
      'Timed out waiting for browser session setup. The user may still be logging in — ask them to finish and retry.',
  };
}

const requestBrowserSession: McpToolDefinition = {
  tool: {
    name: 'request_browser_session',
    description:
      'Ask the gateway to open a headed browser on the host for the user to log in. ' +
      'Sends a chat message with a confirm link. Never ask for passwords. ' +
      'Call this whenever the site shows a login/signin page or session expired — ' +
      'even if browser-sessions/index.json already has an entry (saved cookies may be stale).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        origin: {
          type: 'string',
          description: 'Site origin, e.g. https://app.example.com',
        },
        label: { type: 'string', description: 'Short label for this session' },
        login_url: {
          type: 'string',
          description: 'Optional login page URL (defaults to origin)',
        },
        force: {
          type: 'boolean',
          description:
            'Open a fresh headed login even if a saved session exists (default true). Set false only to reuse a known-good session.',
        },
      },
      required: ['origin'],
    },
  },
  async handler(args) {
    const origin = args.origin as string;
    if (!origin) return err('origin is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'browser_session_request',
        requestId,
        origin,
        label: typeof args.label === 'string' ? args.label : undefined,
        login_url: typeof args.login_url === 'string' ? args.login_url : undefined,
        // Default true: expired cookies still look "active" in the gateway DB.
        force: args.force !== false,
      }),
    });
    log(`browser_session_request: ${requestId} ${origin}`);

    const result = await waitForBrowserSessionResponse(requestId, 120_000);
    if (!result.ok) return err(result.error || 'Browser session request failed');

    const data = result.data ?? {};
    if (data.reused) {
      const sessionId = typeof data.session_id === 'string' ? data.session_id : null;
      const file = sessionId ? `browser-sessions/${sessionId}.json` : 'browser-sessions/<id>.json';
      return ok(
        JSON.stringify(
          {
            status: 'ready',
            reused: true,
            session_id: data.session_id,
            file,
            message: `Existing session ready. Run: agent-browser state load /workspace/agent/${file}`,
          },
          null,
          2,
        ),
      );
    }

    return ok(
      JSON.stringify(
        {
          status: 'pending_user_login',
          session_id: data.session_id,
          connect_url: data.connect_url,
          message:
            data.message ??
            'A browser was opened on the gateway host and the user was notified. Wait for them to confirm login, then list_browser_sessions, state load the new file, open the site, and continue. Do not ask for passwords.',
        },
        null,
        2,
      ),
    );
  },
};

registerTools([requestBrowserSession]);

const listBrowserSessions: McpToolDefinition = {
  tool: {
    name: 'list_browser_sessions',
    description:
      'List gateway-injected browser login sessions available in this workspace (from browser-sessions/index.json). Call this before request_browser_session.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    try {
      const fs = await import('fs');
      const raw = fs.readFileSync('browser-sessions/index.json', 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: unknown };
      return ok(JSON.stringify(parsed, null, 2));
    } catch {
      return ok(JSON.stringify({ sessions: [], message: 'No browser-sessions/index.json yet' }, null, 2));
    }
  },
};

registerTools([listBrowserSessions]);

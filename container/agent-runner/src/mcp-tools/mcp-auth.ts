/**
 * request_mcp_auth — ask the Gateway to start remote MCP OAuth (host-mediated).
 * Never invent localhost / mcp-client authorize links; Gateway posts the real link.
 */
import { findMcpAuthResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `mcp-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

async function waitForMcpAuthResponse(
  requestId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findMcpAuthResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        const parsed = JSON.parse(response.content) as Record<string, unknown>;
        if (parsed.type !== 'mcp_auth_response') continue;
        if (!parsed.ok) {
          return {
            ok: false,
            error: typeof parsed.error === 'string' ? parsed.error : 'Request failed',
          };
        }
        return { ok: true, data: parsed };
      } catch {
        return { ok: false, error: 'Invalid mcp_auth_response JSON' };
      }
    }
    await sleep(250);
  }
  return {
    ok: false,
    error:
      'Timed out waiting for Gateway MCP authorization setup. Ask the user to check chat for an authorize link, then retry.',
  };
}

const requestMcpAuth: McpToolDefinition = {
  tool: {
    name: 'request_mcp_auth',
    description:
      'Ask the NanoClaw Gateway to authorize a remote MCP server (OAuth) and attach it to this agent. ' +
      'REQUIRED when: (1) remote MCP tools fail with 401/403/auth errors, (2) OneCLI cannot inject credentials, ' +
      'or (3) the user needs Zoho/Solo/CRM/invoice data but remote MCP is missing or unauthorized — pass mcp_url if you have it. ' +
      'Do NOT say MCP is "not configured" without calling this tool first when an MCP URL is known or the user can provide one. ' +
      'The Gateway posts a real authorize link to the user chat. ' +
      'NEVER invent, paste, or open localhost / mcp-client /callback OAuth URLs — those mislead users and do not work. ' +
      'After the user authorizes, retry the MCP tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mcp_url: {
          type: 'string',
          description:
            'Remote MCP HTTPS URL to authorize. Optional if this agent already has exactly one remote MCP (or zoho-hosted) configured.',
        },
        mcp_server_name: {
          type: 'string',
          description:
            'Name of the mcpServers entry (e.g. zoho-hosted). Used with or instead of mcp_url to select which server.',
        },
      },
    },
  },
  async handler(args) {
    const mcpUrl = typeof args.mcp_url === 'string' ? args.mcp_url.trim() : '';
    const mcpServerName =
      typeof args.mcp_server_name === 'string' ? args.mcp_server_name.trim() : '';

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'mcp_auth_request',
        requestId,
        mcp_url: mcpUrl || undefined,
        mcp_server_name: mcpServerName || undefined,
      }),
    });
    log(`mcp_auth_request: ${requestId} url=${mcpUrl || '(from config)'} name=${mcpServerName || '-'}`);

    const result = await waitForMcpAuthResponse(requestId, 90_000);
    if (!result.ok) return err(result.error || 'MCP auth request failed');

    const data = result.data ?? {};
    // Do not return authorize_url to the model — Gateway already posted it to chat.
    // Returning it encourages the agent to re-paste links (spam / wrong localhost links).
    const payload = {
      status: data.reused ? 'authorized' : 'pending_user_authorization',
      reused: Boolean(data.reused),
      mcp_url: data.mcp_url ?? null,
      provider: data.provider ?? null,
      authorize_link_delivered_by_gateway: !data.reused,
      message:
        typeof data.message === 'string'
          ? data.message
          : data.reused
            ? 'Already authorized. Retry MCP tools now.'
            : 'Gateway sent the authorize link to the user in chat. Tell them briefly to open that Gateway message, then wait and retry MCP tools. Do not invent or paste any OAuth URLs yourself.',
      rules: [
        'Do not invent or share localhost OAuth /callback links',
        'Do not share mcp-client authorize URLs with redirect_uri=localhost',
        'Do not paste authorize URLs into chat — Gateway already notified the user',
        'Only call request_mcp_auth; never call mcp__*__authenticate or complete_authentication',
        'After the user finishes browser auth, retry the real Zoho/MCP tools (not authenticate)',
      ],
    };

    return ok(JSON.stringify(payload, null, 2));
  },
};

registerTools([requestMcpAuth]);

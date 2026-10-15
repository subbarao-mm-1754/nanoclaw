/**
 * Host-mediated remote MCP OAuth — started by the agent `request_mcp_auth` tool
 * (via Worker → this Gateway internal API), never by Claude-local localhost OAuth.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import { invalidateWorkerWorkspaceCache } from '../agent-service.js';
import { getWorkspace } from '../store/workspaces.js';
import type { ContainerConfigSnapshot, McpServerConfig } from '../../container-config.js';
import {
  enqueueMcpAuthReadyForWorkspace,
  IntegrationError,
  startOAuthConnect,
} from './broker.js';
import { suggestMcpServerName } from './mcp-url.js';

export type McpAuthNotify = {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
};

export type McpAuthRequestResult = {
  ok: boolean;
  reused?: boolean;
  authorize_url?: string | null;
  mcp_url?: string | null;
  provider?: string;
  connection_id?: string;
  message?: string;
  error?: string;
};

function remoteMcpUrlFromConfig(
  config: ContainerConfigSnapshot | null | undefined,
  serverName?: string | null,
): { url: string; name: string } | null {
  const servers = config?.mcpServers ?? {};
  const entries = Object.entries(servers).filter(([, cfg]) => {
    if (!cfg || typeof cfg !== 'object') return false;
    const c = cfg as McpServerConfig;
    return (
      (c.type === 'http' || c.type === 'sse' || !c.type) &&
      typeof (c as { url?: string }).url === 'string' &&
      Boolean((c as { url: string }).url)
    );
  }) as Array<[string, McpServerConfig & { url: string }]>;

  if (serverName) {
    const hit = entries.find(([n]) => n === serverName);
    if (hit) return { name: hit[0], url: hit[1].url };
    return null;
  }
  if (entries.length === 1) {
    return { name: entries[0]![0], url: entries[0]![1].url };
  }
  // Prefer zoho-hosted when several remotes exist
  const zoho = entries.find(([n]) => n === 'zoho-hosted' || /zohomcp/i.test(n));
  if (zoho) return { name: zoho[0], url: zoho[1].url };
  return null;
}

async function notifyChannel(
  notify: McpAuthNotify,
  text: string,
): Promise<void> {
  if (!notify.channel_type || !notify.platform_id) return;
  const adapter = getChannelAdapter(notify.channel_type);
  if (!adapter) {
    log.warn('No channel adapter for mcp-auth notify', {
      channelType: notify.channel_type,
    });
    return;
  }
  await adapter.deliver(notify.platform_id, notify.thread_id, {
    kind: 'chat',
    content: { text },
  });
}

/**
 * Start (or reuse) Gateway OAuth for a remote MCP on behalf of the workspace owner.
 * Posts the authorize link to the chat channel when fresh consent is required.
 */
export async function handleMcpAuthRequest(input: {
  workspace_id: string;
  mcp_url?: string | null;
  mcp_server_name?: string | null;
  notify?: McpAuthNotify | null;
}): Promise<McpAuthRequestResult> {
  const workspace = getWorkspace(input.workspace_id);
  if (!workspace) {
    return { ok: false, error: 'Workspace not found' };
  }
  if (!workspace.owner_user_id) {
    return { ok: false, error: 'Workspace has no owner user' };
  }

  let mcpUrl = input.mcp_url?.trim() || null;
  let serverName = input.mcp_server_name?.trim() || null;

  if (!mcpUrl) {
    const fromConfig = remoteMcpUrlFromConfig(workspace.container_config, serverName);
    if (!fromConfig) {
      return {
        ok: false,
        error: serverName
          ? `No remote MCP URL found for server "${serverName}" in agent config`
          : 'mcp_url is required when the agent has no (or multiple) remote MCP servers configured',
      };
    }
    mcpUrl = fromConfig.url;
    serverName = serverName || fromConfig.name;
  }

  try {
    const result = await startOAuthConnect({
      userId: workspace.owner_user_id,
      mcpUrl,
      mcpServerName: serverName || suggestMcpServerName(mcpUrl),
      workspaceId: workspace.workspace_id,
    });

    invalidateWorkerWorkspaceCache(workspace.workspace_id);

    if (result.reused) {
      try {
        const { ensureWorkspaceOnWorker } = await import('../agent-service.js');
        await ensureWorkspaceOnWorker(workspace.workspace_id);
      } catch (err) {
        log.warn('mcp-auth reused: failed to rematerialize workspace', { err });
      }
      await enqueueMcpAuthReadyForWorkspace(workspace.workspace_id, {
        mcpUrl: result.mcp_url ?? mcpUrl,
        mcpServerName: serverName,
      });
      const message =
        'Remote MCP is authorized for this agent (OneCLI will inject credentials). ' +
        'A [mcp-auth-ready] wake was queued — after MCP reconnects, retry the real tools ' +
        '(not authenticate). Do not invent or share authorize links.';
      if (input.notify) {
        await notifyChannel(
          input.notify,
          [
            `Remote MCP ready for **${workspace.name}**.`,
            '',
            `URL: ${result.mcp_url ?? mcpUrl}`,
            'Credentials are managed by the Gateway/OneCLI. The agent was notified to continue.',
          ].join('\n'),
        );
      }
      return {
        ok: true,
        reused: true,
        authorize_url: null,
        mcp_url: result.mcp_url ?? mcpUrl,
        provider: result.provider,
        connection_id: result.connection_id,
        message,
      };
    }

    const authorizeUrl = result.authorize_url;
    if (!authorizeUrl) {
      return {
        ok: false,
        error: 'OAuth start did not return an authorize URL',
        mcp_url: mcpUrl,
      };
    }

    if (input.notify) {
      await notifyChannel(
        input.notify,
        [
          `Remote MCP authorization needed for **${workspace.name}**.`,
          '',
          'Open this Gateway link (do not use any localhost callback links):',
          authorizeUrl,
          '',
          'After you authorize, retry your request in this chat.',
        ].join('\n'),
      );
    }

    return {
      ok: true,
      reused: false,
      authorize_url: authorizeUrl,
      mcp_url: result.mcp_url ?? mcpUrl,
      provider: result.provider,
      connection_id: result.connection_id,
      message:
        'A Gateway authorize link was sent to the user in chat. ' +
        'Wait for them to complete it, then retry MCP tools. ' +
        'Never invent localhost or mcp-client OAuth URLs.',
    };
  } catch (err) {
    const message =
      err instanceof IntegrationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn('mcp auth request failed', {
      workspaceId: input.workspace_id,
      mcpUrl,
      err: message,
    });
    return { ok: false, error: message, mcp_url: mcpUrl };
  }
}

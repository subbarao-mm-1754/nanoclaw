import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const startOAuthConnectMock = vi.fn();

vi.mock('./broker.js', async () => {
  const actual = await vi.importActual<typeof import('./broker.js')>('./broker.js');
  return {
    ...actual,
    startOAuthConnect: (...args: unknown[]) => startOAuthConnectMock(...args),
  };
});

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => ({
    deliver: vi.fn(async () => undefined),
  })),
}));

vi.mock('../agent-service.js', () => ({
  invalidateWorkerWorkspaceCache: vi.fn(),
  ensureWorkspaceOnWorker: vi.fn(async () => undefined),
}));

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import { registerWorkspace } from '../store/workspaces.js';
import { defaultContainerConfig } from '../store/agent-files.js';
import { handleMcpAuthRequest } from './mcp-auth-request.js';

beforeEach(() => {
  initGatewayTestDb();
  startOAuthConnectMock.mockReset();
});

afterEach(() => {
  closeGatewayDb();
});

describe('handleMcpAuthRequest', () => {
  it('reuses an existing connection without exposing a new authorize flow as localhost', async () => {
    const user = createUser({
      email: 'mcpauth@example.com',
      password: 'password123',
      display_name: 'MCP Auth',
    });
    registerWorkspace({
      workspace_id: 'ws-mcp-auth-1',
      agent_group_id: 'ag-mcp-auth-1',
      name: 'SoloAssistant',
      owner_user_id: user.id,
      folder: 'solo',
      cli_scope: 'group',
      container_config: {
        ...defaultContainerConfig('SoloAssistant'),
        mcpServers: {
          'zoho-hosted': {
            type: 'http',
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer onecli-managed' },
          },
        },
      },
    });

    startOAuthConnectMock.mockResolvedValue({
      authorize_url: null,
      reused: true,
      connection_id: 'oauth-1',
      state: null,
      provider: 'zoho-hosted',
      mcp_url: 'https://mcp.example.com/sse',
    });

    const result = await handleMcpAuthRequest({
      workspace_id: 'ws-mcp-auth-1',
      mcp_server_name: 'zoho-hosted',
      notify: {
        channel_type: 'zoho-cliq',
        platform_id: 'chat-1',
        thread_id: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.authorize_url).toBeNull();
    expect(startOAuthConnectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        workspaceId: 'ws-mcp-auth-1',
        mcpUrl: 'https://mcp.example.com/sse',
      }),
    );
  });

  it('resolves mcp_url from container config and returns Gateway authorize_url', async () => {
    const user = createUser({
      email: 'resolve@example.com',
      password: 'password123',
      display_name: 'Resolve',
    });
    registerWorkspace({
      workspace_id: 'ws-mcp-auth-2',
      agent_group_id: 'ag-mcp-auth-2',
      name: 'AgentTwo',
      owner_user_id: user.id,
      folder: 'two',
      container_config: {
        ...defaultContainerConfig('AgentTwo'),
        mcpServers: {
          'zoho-hosted': {
            type: 'http',
            url: 'https://solo.mcp.testzohomcp.com/mcp/key/message',
            headers: { Authorization: 'Bearer onecli-managed' },
          },
        },
      },
    });

    startOAuthConnectMock.mockResolvedValue({
      authorize_url:
        'https://accounts.example.com/oauth?redirect_uri=http%3A%2F%2F127.0.0.1%3A8090%2Fv1%2Fintegrations%2Foauth%2Fcallback',
      reused: false,
      connection_id: 'oauth-x',
      state: 'abc',
      provider: 'zoho-hosted',
      mcp_url: 'https://solo.mcp.testzohomcp.com/mcp/key/message',
    });

    const result = await handleMcpAuthRequest({
      workspace_id: 'ws-mcp-auth-2',
      notify: {
        channel_type: 'zoho-cliq',
        platform_id: 'chat-2',
        thread_id: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.authorize_url).toMatch(
      /127\.0\.0\.1(%3A|:)8090(%2F|\/)v1(%2F|\/)integrations(%2F|\/)oauth(%2F|\/)callback/,
    );
    expect(result.mcp_url).toContain('testzohomcp.com');
    expect(startOAuthConnectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpUrl: 'https://solo.mcp.testzohomcp.com/mcp/key/message',
        workspaceId: 'ws-mcp-auth-2',
      }),
    );
  });

  it('errors when workspace has no remote MCP and no mcp_url', async () => {
    const user = createUser({
      email: 'empty@example.com',
      password: 'password123',
      display_name: 'Empty',
    });
    registerWorkspace({
      workspace_id: 'ws-mcp-auth-3',
      agent_group_id: 'ag-mcp-auth-3',
      name: 'EmptyAgent',
      owner_user_id: user.id,
      folder: 'empty',
      container_config: defaultContainerConfig('EmptyAgent'),
    });

    const result = await handleMcpAuthRequest({ workspace_id: 'ws-mcp-auth-3' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mcp_url is required/i);
    expect(startOAuthConnectMock).not.toHaveBeenCalled();
  });
});

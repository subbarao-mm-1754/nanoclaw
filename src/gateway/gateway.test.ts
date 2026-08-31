import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb, getGatewayDb } from './db/connection.js';
import { initGatewaySchema } from './db/schema.js';
import { processNextPendingInbound } from './processor.js';
import { registerWorkspace } from './store/workspaces.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getOrCreateConversation } from './store/conversations.js';
import { getMessage } from './store/messages.js';
import { countMessagesByStatus } from './store/messages.js';
import { getHttpResponse, saveHttpResponse } from './store/http-responses.js';
import './http-channel.js';

const processMessageOnWorkerMock = vi.fn();
const prepareWorkspaceOnWorkerMock = vi.fn();

vi.mock('./worker-client.js', () => ({
  processMessageOnWorker: (...args: unknown[]) => processMessageOnWorkerMock(...args),
  prepareWorkspaceOnWorker: (...args: unknown[]) => prepareWorkspaceOnWorkerMock(...args),
  enqueueProcessMessageOnWorker: vi.fn(),
  destroyWorkspaceOnWorker: vi.fn(),
}));

const deliverOutboundMessageMock = vi.fn();

vi.mock('./delivery.js', async () => {
  const actual = await vi.importActual<typeof import('./delivery.js')>('./delivery.js');
  return {
    ...actual,
    deliverOutboundMessage: (...args: unknown[]) => deliverOutboundMessageMock(...args),
  };
});

beforeEach(() => {
  initGatewayTestDb();
  processMessageOnWorkerMock.mockReset();
  prepareWorkspaceOnWorkerMock.mockReset();
  prepareWorkspaceOnWorkerMock.mockResolvedValue({
    workspace_id: 'ws-prepared',
    status: 'prepared',
    workspace: { root: '/tmp', group_dir: '/tmp/agent', claude_shared_dir: '/tmp/.claude' },
    files_written: ['CLAUDE.local.md'],
  });
  deliverOutboundMessageMock.mockReset();
  deliverOutboundMessageMock.mockResolvedValue(undefined);
});

afterEach(() => {
  closeGatewayDb();
});

describe('gateway stores', () => {
  it('registers workspace and creates conversation', () => {
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Test Agent',
      is_default: true,
    });

    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: 'client-1',
      thread_id: null,
    });

    expect(conv.workspace_id).toBe('ws-1');
    expect(conv.session_id).toBe(`sess-${conv.id}`);
  });

  it('enqueues inbound message', () => {
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Test Agent',
      is_default: true,
    });
    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: 'client-1',
      thread_id: null,
    });

    enqueueInboundMessage(
      {
        id: 'msg-1',
        channel_type: 'http',
        platform_id: 'client-1',
        thread_id: null,
        kind: 'chat',
        content: { text: 'Hello' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    const counts = countMessagesByStatus();
    expect(counts.pending).toBe(1);
  });

  it('stores http outbound for response polling', () => {
    saveHttpResponse({
      inbound_id: 'msg-http-1',
      platform_id: 'client-1',
      thread_id: null,
      outbound: [
        {
          id: 'out-1',
          kind: 'chat',
          channel_type: 'http',
          platform_id: 'client-1',
          thread_id: null,
          content: { text: 'Hello back' },
        },
      ],
    });

    const stored = getHttpResponse('msg-http-1');
    expect(stored?.outbound[0]?.content.text).toBe('Hello back');
  });
});

describe('gateway processor', () => {
  it('calls worker, delivers outbound, and deletes processed messages', async () => {
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Test Agent',
      is_default: true,
    });
    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: 'client-1',
      thread_id: null,
    });

    enqueueInboundMessage(
      {
        id: 'msg-in-1',
        channel_type: 'http',
        platform_id: 'client-1',
        thread_id: null,
        kind: 'chat',
        content: { text: 'Create contact Scott' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    processMessageOnWorkerMock.mockResolvedValue({
      job_id: 'job-1',
      status: 'completed',
      workspace_id: 'ws-1',
      session: { id: conv.session_id, agent_group_id: 'ag-1' },
      workspace: { root: '/tmp', group_dir: '/tmp/agent', claude_shared_dir: '/tmp/.claude' },
      session_paths: { inbound_db: '/tmp/in.db', outbound_db: '/tmp/out.db' },
      inbound_message_id: 'msg-in-1',
      outbound: [
        {
          id: 'msg-out-1',
          kind: 'chat',
          channel_type: 'http',
          platform_id: 'client-1',
          thread_id: null,
          content: { text: 'Created Scott.' },
        },
      ],
    });

    await processNextPendingInbound();

    expect(processMessageOnWorkerMock).toHaveBeenCalledTimes(1);
    const workerPayload = processMessageOnWorkerMock.mock.calls[0][0] as {
      inbound: { id: string };
    };
    expect(workerPayload.inbound.id).toBe('msg-in-1:ag-1');
    expect(deliverOutboundMessageMock).toHaveBeenCalledTimes(1);
    expect(getMessage('msg-in-1')).toBeNull();
    expect(getMessage('msg-out-1')).toBeNull();
    expect(countMessagesByStatus().pending).toBe(0);
  });

  it('marks inbound failed when worker returns non-completed status', async () => {
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Test Agent',
      is_default: true,
    });
    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: 'client-1',
      thread_id: null,
    });

    enqueueInboundMessage(
      {
        id: 'msg-in-2',
        channel_type: 'http',
        platform_id: 'client-1',
        thread_id: null,
        kind: 'chat',
        content: { text: 'Hi' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    processMessageOnWorkerMock.mockResolvedValue({
      job_id: 'job-2',
      status: 'failed',
      workspace_id: 'ws-1',
      session: { id: conv.session_id, agent_group_id: 'ag-1' },
      workspace: { root: '/tmp', group_dir: '/tmp/agent', claude_shared_dir: '/tmp/.claude' },
      session_paths: { inbound_db: '/tmp/in.db', outbound_db: '/tmp/out.db' },
      inbound_message_id: 'msg-in-2',
      error: 'container error',
    });

    await processNextPendingInbound();

    const msg = getMessage('msg-in-2');
    expect(msg?.status).toBe('failed');
    expect(msg?.error).toContain('container error');
  });

  it('skips duplicate platform message enqueue', () => {
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Test Agent',
      is_default: true,
    });
    const conv = getOrCreateConversation({
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-1',
      thread_id: null,
    });

    const input = {
      id: '1782463173318_12936646455',
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-1',
      thread_id: null,
      kind: 'chat',
      content: { text: 'Hello' },
      timestamp: new Date().toISOString(),
    };

    enqueueInboundMessage(input, conv.id);
    enqueueInboundMessage(input, conv.id);

    expect(countMessagesByStatus().pending).toBe(1);
  });
});

describe('gateway auth and agents', () => {
  it('registers users and creates owner-scoped agents', async () => {
    const { createUser } = await import('./store/users.js');
    const { createAgent, getAgent } = await import('./agent-service.js');
    const { AgentAccessError } = await import('./store/agent-files.js');
    const { updateAgentFilesRecord } = await import('./store/agents.js');

    const alice = createUser({
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    });
    const bob = createUser({
      email: 'bob@example.com',
      password: 'password123',
      display_name: 'Bob',
    });

    const agent = await createAgent({
      name: 'Alice Agent',
      owner_user_id: alice.id,
      files: [{ path: 'CLAUDE.local.md', content: 'Be helpful.' }],
    });

    expect(agent.owner_user_id).toBe(alice.id);
    expect(prepareWorkspaceOnWorkerMock).toHaveBeenCalledTimes(1);
    expect(getAgent(agent.workspace_id, alice.id)?.files).toHaveLength(1);

    expect(getAgent(agent.workspace_id, bob.id)).toBeNull();
    expect(() =>
      updateAgentFilesRecord(agent.workspace_id, bob.id, [
        { path: 'CLAUDE.local.md', content: 'Hacked' },
      ]),
    ).toThrow(AgentAccessError);
  });

  it('forwards mcpServers to worker on create and update', async () => {
    const { createUser } = await import('./store/users.js');
    const { createAgent, updateAgent } = await import('./agent-service.js');

    const alice = createUser({
      email: 'mcp@example.com',
      password: 'password123',
      display_name: 'MCP User',
    });

    const mcpConfig = {
      provider: 'claude',
      skills: 'all' as const,
      mcpServers: {
        ZohoMCP: {
          command: 'npx',
          args: ['mcp-remote', 'https://example.test/mcp'],
        },
      },
      packages: { apt: [] as string[], npm: [] as string[] },
      additionalMounts: [],
    };

    const agent = await createAgent({
      name: 'MCP Agent',
      owner_user_id: alice.id,
      container_config: mcpConfig,
      files: [{ path: 'CLAUDE.local.md', content: 'Use MCP.' }],
    });

    expect(prepareWorkspaceOnWorkerMock.mock.calls[0][0].agent.container_config.mcpServers).toEqual(
      mcpConfig.mcpServers,
    );

    prepareWorkspaceOnWorkerMock.mockClear();

    await updateAgent(agent.workspace_id, alice.id, {
      container_config: {
        ...mcpConfig,
        mcpServers: {
          ZohoMCP: {
            command: 'npx',
            args: ['mcp-remote', 'https://example.test/mcp-v2'],
            instructions: 'Use for CRM lookups.',
          },
        },
      },
    });

    expect(prepareWorkspaceOnWorkerMock).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceOnWorkerMock.mock.calls[0][0].options.replace).toBe(true);
    expect(
      prepareWorkspaceOnWorkerMock.mock.calls[0][0].agent.container_config.mcpServers.ZohoMCP.args,
    ).toEqual(['mcp-remote', 'https://example.test/mcp-v2']);
  });
});

describe('gateway schema', () => {
  it('initGatewaySchema is idempotent on an existing database', () => {
    registerWorkspace({
      workspace_id: 'ws-existing',
      agent_group_id: 'ag-existing',
      name: 'Existing',
      is_default: true,
    });

    expect(() => initGatewaySchema(getGatewayDb())).not.toThrow();
    expect(() => initGatewaySchema(getGatewayDb())).not.toThrow();

    const workspace = getGatewayDb()
      .prepare('SELECT workspace_id FROM gateway_workspaces WHERE workspace_id = ?')
      .get('ws-existing');
    expect(workspace).toBeTruthy();
  });
});

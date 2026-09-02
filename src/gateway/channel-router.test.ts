import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from './db/connection.js';
import { routeChannelInbound, BUILD_HELP_TEXT } from './channel-router.js';
import { getActiveBuildJobForUser } from './store/builds.js';
import { handleBuilderRunCallback } from './builder/service.js';

const prepareWorkspaceOnWorkerMock = vi.fn();
const enqueueProcessMessageOnWorkerMock = vi.fn();
const destroyWorkspaceOnWorkerMock = vi.fn();
const createAgentMock = vi.fn();
const deliverMock = vi.fn();
const { startOAuthConnectMock } = vi.hoisted(() => ({
  startOAuthConnectMock: vi.fn(),
}));

vi.mock('./worker-client.js', () => ({
  prepareWorkspaceOnWorker: (...args: unknown[]) => prepareWorkspaceOnWorkerMock(...args),
  enqueueProcessMessageOnWorker: (...args: unknown[]) => enqueueProcessMessageOnWorkerMock(...args),
  destroyWorkspaceOnWorker: (...args: unknown[]) => destroyWorkspaceOnWorkerMock(...args),
  processMessageOnWorker: vi.fn(),
}));

vi.mock('./agent-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-service.js')>();
  return {
    ...actual,
    createAgent: (...args: unknown[]) => createAgentMock(...args),
    ensureWorkspaceOnWorker: vi.fn(async () => undefined),
  };
});

vi.mock('./integrations/broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/broker.js')>();
  return {
    ...actual,
    startOAuthConnect: (...args: unknown[]) => startOAuthConnectMock(...args),
  };
});

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({
    deliver: (...args: unknown[]) => deliverMock(...args),
  }),
}));

beforeEach(() => {
  initGatewayTestDb();
  prepareWorkspaceOnWorkerMock.mockReset();
  enqueueProcessMessageOnWorkerMock.mockReset();
  destroyWorkspaceOnWorkerMock.mockReset();
  createAgentMock.mockReset();
  deliverMock.mockReset();
  startOAuthConnectMock.mockReset();

  prepareWorkspaceOnWorkerMock.mockResolvedValue({
    workspace_id: 'ws-builder',
    status: 'prepared',
    workspace: { root: '/tmp', group_dir: '/tmp/a', claude_shared_dir: '/tmp/c' },
    files_written: ['CLAUDE.local.md'],
  });
  enqueueProcessMessageOnWorkerMock.mockResolvedValue({ run_id: 'run-1', status: 'accepted' });
  destroyWorkspaceOnWorkerMock.mockResolvedValue(undefined);
  deliverMock.mockResolvedValue(undefined);
  startOAuthConnectMock.mockResolvedValue({
    authorize_url: 'https://accounts.zoho.in/oauth/v2/auth?state=test',
    reused: false,
    connection_id: 'conn-1',
    state: 'test',
    provider: 'zoho-hosted',
    mcp_url: 'https://example.zohomcp.com/mcp/KEY/message',
  });
  createAgentMock.mockResolvedValue({
    workspace_id: 'ws-result',
    agent_group_id: 'ag-result',
    name: 'X',
    is_default: false,
    owner_user_id: 'u',
    folder: 'x',
    cli_scope: 'group',
    container_config: null,
    files: [],
    created_at: '',
    updated_at: '',
  });
});

afterEach(() => {
  closeGatewayDb();
});

describe('routeChannelInbound', () => {
  const base = {
    channel_type: 'zoho-cliq',
    platform_id: 'zoho-cliq:chat-1',
    thread_id: null as string | null,
  };

  it('routes plain messages to the user agent when no build is active', async () => {
    const result = await routeChannelInbound({
      ...base,
      content: { text: 'Hello agent', senderId: 'zoho-cliq:u1', sender: 'Ada' },
    });
    expect(result).toEqual({ kind: 'agent' });
    expect(enqueueProcessMessageOnWorkerMock).not.toHaveBeenCalled();
  });

  it('starts a build on /build and stores Cliq delivery', async () => {
    const result = await routeChannelInbound({
      ...base,
      content: {
        text: '/build Create a HubSpot summarizer',
        senderId: 'zoho-cliq:u1',
        sender: 'Ada',
      },
    });

    expect(result.kind).toBe('builder');
    if (result.kind !== 'builder') return;
    expect(result.action).toBe('started');
    expect(result.jobId).toBeTruthy();
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();

    const payload = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0] as {
      delivery: { channel_type: string; platform_id: string };
    };
    expect(payload.delivery.channel_type).toBe('zoho-cliq');
    expect(payload.delivery.platform_id).toBe('zoho-cliq:chat-1');
    expect(deliverMock).toHaveBeenCalled();
  });

  it('continues an active waiting build with a normal Cliq reply', async () => {
    const started = await routeChannelInbound({
      ...base,
      content: { text: '/build Make a CRM bot', senderId: 'zoho-cliq:u2', sender: 'Bob' },
    });
    expect(started.kind).toBe('builder');
    if (started.kind !== 'builder' || !started.jobId) throw new Error('expected job');

    const runId = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0].job_id as string;
    await handleBuilderRunCallback({
      job_id: runId,
      build_job_id: started.jobId,
      status: 'completed',
      workspace_id: 'ws-builder',
      session: { id: 's', agent_group_id: 'ag' },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 'm1',
      outbound: [
        {
          id: 'o1',
          kind: 'chat',
          channel_type: 'zoho-cliq',
          platform_id: base.platform_id,
          thread_id: null,
          content: { text: 'Which CRM?\n\n```nanoclaw-build\n{"status":"needs_input"}\n```' },
        },
      ],
    });

    enqueueProcessMessageOnWorkerMock.mockClear();
    const continued = await routeChannelInbound({
      ...base,
      content: { text: 'HubSpot please', senderId: 'zoho-cliq:u2', sender: 'Bob' },
    });
    expect(continued).toEqual({
      kind: 'builder',
      action: 'continued',
      jobId: started.jobId,
    });
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();
  });

  it('cancels an active build with /cancel', async () => {
    const { ensureUserForChannelSender } = await import('./store/channel-identities.js');

    const started = await routeChannelInbound({
      ...base,
      content: { text: '/build Something', senderId: 'zoho-cliq:u3', sender: 'Cara' },
    });
    expect(started.kind).toBe('builder');
    if (started.kind !== 'builder' || !started.jobId) throw new Error('expected job');

    const user = ensureUserForChannelSender({
      channel_type: 'zoho-cliq',
      sender_id: 'zoho-cliq:u3',
    });
    expect(getActiveBuildJobForUser(user.id)?.id).toBe(started.jobId);

    const cancelled = await routeChannelInbound({
      ...base,
      content: { text: '/cancel', senderId: 'zoho-cliq:u3', sender: 'Cara' },
    });
    expect(cancelled.kind).toBe('builder');
    if (cancelled.kind === 'builder') expect(cancelled.action).toBe('cancelled');
    expect(getActiveBuildJobForUser(user.id)).toBeNull();
  });

  it('replies with help text on /help', async () => {
    const result = await routeChannelInbound({
      ...base,
      content: { text: '/help', senderId: 'zoho-cliq:u4', sender: 'Dan' },
    });
    expect(result).toEqual({ kind: 'builder', action: 'help' });
    expect(deliverMock.mock.calls.some((c) => String(c[2]?.content?.text ?? '').includes('/build'))).toBe(
      true,
    );
    expect(BUILD_HELP_TEXT).toContain('/build');
    expect(BUILD_HELP_TEXT).toContain('MCP URL');
  });

  it('starts OAuth when /build includes a Zoho MCP URL', async () => {
    const mcp =
      'https://mail-mcp.zohomcp.com/mcp/message?key=abc123';
    const result = await routeChannelInbound({
      ...base,
      content: {
        text: `/build CRM agent that uses ${mcp}`,
        senderId: 'zoho-cliq:u5',
        sender: 'Eve',
      },
    });

    expect(result.kind).toBe('builder');
    if (result.kind !== 'builder') return;
    expect(result.action).toBe('started');
    expect(startOAuthConnectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpUrl: expect.stringContaining('zohomcp.com'),
        buildJobId: result.jobId,
      }),
    );
    const oauthReply = deliverMock.mock.calls.some((c) =>
      String(c[2]?.content?.text ?? '').includes('Open this link:'),
    );
    expect(oauthReply).toBe(true);
  });

  it('starts OAuth on /mcp during a waiting build without enqueueing builder', async () => {
    const started = await routeChannelInbound({
      ...base,
      content: { text: '/build Make a mail bot', senderId: 'zoho-cliq:u6', sender: 'Fay' },
    });
    expect(started.kind).toBe('builder');
    if (started.kind !== 'builder' || !started.jobId) throw new Error('expected job');

    const runId = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0].job_id as string;
    await handleBuilderRunCallback({
      job_id: runId,
      build_job_id: started.jobId,
      status: 'completed',
      workspace_id: 'ws-builder',
      session: { id: 's', agent_group_id: 'ag' },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 'm1',
      outbound: [
        {
          id: 'o1',
          kind: 'chat',
          channel_type: 'zoho-cliq',
          platform_id: base.platform_id,
          thread_id: null,
          content: { text: 'Paste MCP?\n\n```nanoclaw-build\n{"status":"needs_input"}\n```' },
        },
      ],
    });

    enqueueProcessMessageOnWorkerMock.mockClear();
    startOAuthConnectMock.mockClear();
    deliverMock.mockClear();

    const continued = await routeChannelInbound({
      ...base,
      content: {
        text: '/mcp https://mail-mcp.zohomcp.com/mcp/message?key=xyz',
        senderId: 'zoho-cliq:u6',
        sender: 'Fay',
      },
    });

    expect(continued).toEqual({
      kind: 'builder',
      action: 'continued',
      jobId: started.jobId,
    });
    expect(startOAuthConnectMock).toHaveBeenCalled();
    expect(enqueueProcessMessageOnWorkerMock).not.toHaveBeenCalled();
  });

  it('starts /edit without switching the Cliq-bound agent and tests the draft', async () => {
    const { ensureUserForChannelSender } = await import('./store/channel-identities.js');
    const { createAgentRecord } = await import('./store/agents.js');
    const { setConversationWorkspace, findConversation } = await import('./store/conversations.js');

    const user = ensureUserForChannelSender({
      channel_type: 'zoho-cliq',
      sender_id: 'zoho-cliq:u-edit',
      display_name: 'Ada',
    });
    const chatAgent = createAgentRecord({
      name: 'Chat Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# chat' }],
    });
    const target = createAgentRecord({
      name: 'Mail Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# mail' }],
    });
    setConversationWorkspace({
      channel_type: base.channel_type,
      platform_id: base.platform_id,
      thread_id: base.thread_id,
      workspace_id: chatAgent.workspace_id,
    });

    const edited = await routeChannelInbound({
      ...base,
      content: { text: '/edit Mail Bot: be shorter', senderId: 'zoho-cliq:u-edit', sender: 'Ada' },
    });
    expect(edited.kind).toBe('builder');
    if (edited.kind !== 'builder' || !edited.jobId) return;
    expect(edited.action).toBe('edit');
    expect(findConversation(base.channel_type, base.platform_id, base.thread_id)?.workspace_id).toBe(
      chatAgent.workspace_id,
    );

    const runId = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0].job_id as string;
    await handleBuilderRunCallback({
      job_id: runId,
      build_job_id: edited.jobId,
      status: 'completed',
      workspace_id: 'ws-builder',
      session: { id: 's', agent_group_id: 'ag' },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 'm1',
      outbound: [
        {
          id: 'o1',
          kind: 'chat',
          channel_type: 'zoho-cliq',
          platform_id: base.platform_id,
          thread_id: null,
          content: {
            text: `Draft ready.\n\n\`\`\`nanoclaw-build\n{"status":"needs_input","files":[{"path":"CLAUDE.local.md","content":"# mail shorter"}]}\n\`\`\``,
          },
        },
      ],
    });

    enqueueProcessMessageOnWorkerMock.mockClear();
    const tested = await routeChannelInbound({
      ...base,
      content: { text: '/test Summarize this inbox', senderId: 'zoho-cliq:u-edit', sender: 'Ada' },
    });
    expect(tested).toEqual({ kind: 'builder', action: 'test', jobId: edited.jobId });
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();
    const payload = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0] as {
      workspace_id: string;
    };
    expect(payload.workspace_id).toMatch(/^ws-preview-/);
    expect(findConversation(base.channel_type, base.platform_id, base.thread_id)?.workspace_id).toBe(
      chatAgent.workspace_id,
    );
    expect(target.workspace_id).not.toBe(chatAgent.workspace_id);
  });

  it('lists edit and test in /help', async () => {
    const result = await routeChannelInbound({
      ...base,
      content: { text: '/help', senderId: 'zoho-cliq:u-help2', sender: 'Ada' },
    });
    expect(result).toEqual({ kind: 'builder', action: 'help' });
    expect(BUILD_HELP_TEXT).toContain('/edit');
    expect(BUILD_HELP_TEXT).toContain('/test');
    expect(BUILD_HELP_TEXT).toContain('/save');
    expect(BUILD_HELP_TEXT).toContain('/delete');
  });

  it('deletes an agent via /delete and rebinds this chat', async () => {
    const { createAgentRecord, getAgentForUser } = await import('./store/agents.js');
    const { setConversationWorkspace, findConversation } = await import('./store/conversations.js');
    const { ensureUserForChannelSender } = await import('./store/channel-identities.js');

    const user = ensureUserForChannelSender({
      channel_type: 'zoho-cliq',
      sender_id: 'zoho-cliq:u-del',
    });
    const keep = createAgentRecord({
      name: 'KeepBot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# keep' }],
    });
    const doomed = createAgentRecord({
      name: 'DoomedBot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# doomed' }],
    });
    setConversationWorkspace({
      channel_type: base.channel_type,
      platform_id: base.platform_id,
      thread_id: base.thread_id,
      workspace_id: doomed.workspace_id,
    });

    deliverMock.mockClear();
    destroyWorkspaceOnWorkerMock.mockClear();

    const result = await routeChannelInbound({
      ...base,
      content: { text: '/delete DoomedBot', senderId: 'zoho-cliq:u-del', sender: 'Ada' },
    });
    expect(result).toEqual({ kind: 'builder', action: 'delete' });
    expect(getAgentForUser(doomed.workspace_id, user.id)).toBeNull();
    expect(findConversation(base.channel_type, base.platform_id, base.thread_id)?.workspace_id).toBe(
      keep.workspace_id,
    );
    expect(destroyWorkspaceOnWorkerMock).toHaveBeenCalledWith({ workspace_id: doomed.workspace_id });
    expect(
      deliverMock.mock.calls.some((c) =>
        String(c[2]?.content?.text ?? '').includes('Deleted agent "DoomedBot"'),
      ),
    ).toBe(true);
  });

  it('skips the authorize link when MCP OAuth is already connected for the user', async () => {
    startOAuthConnectMock.mockResolvedValueOnce({
      authorize_url: null,
      reused: true,
      connection_id: 'conn-existing',
      state: null,
      provider: 'zoho-hosted',
      mcp_url: 'https://mail-mcp.zohomcp.com/mcp/message?key=abc',
    });

    const mcp = 'https://mail-mcp.zohomcp.com/mcp/message?key=abc';
    deliverMock.mockClear();
    const result = await routeChannelInbound({
      ...base,
      content: {
        text: `/build Mail bot that uses ${mcp}`,
        senderId: 'zoho-cliq:u-reuse',
        sender: 'Reuse',
      },
    });
    expect(result.kind).toBe('builder');
    if (result.kind !== 'builder') return;
    expect(result.action).toBe('started');
    expect(startOAuthConnectMock).toHaveBeenCalled();
    const text = deliverMock.mock.calls.map((c) => String(c[2]?.content?.text ?? '')).join('\n');
    expect(text).toMatch(/already authorized/i);
    expect(text).not.toMatch(/Open this link:/);
  });
});

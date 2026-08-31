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

vi.mock('./worker-client.js', () => ({
  prepareWorkspaceOnWorker: (...args: unknown[]) => prepareWorkspaceOnWorkerMock(...args),
  enqueueProcessMessageOnWorker: (...args: unknown[]) => enqueueProcessMessageOnWorkerMock(...args),
  destroyWorkspaceOnWorker: (...args: unknown[]) => destroyWorkspaceOnWorkerMock(...args),
  processMessageOnWorker: vi.fn(),
}));

vi.mock('./agent-service.js', () => ({
  createAgent: (...args: unknown[]) => createAgentMock(...args),
}));

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

  prepareWorkspaceOnWorkerMock.mockResolvedValue({
    workspace_id: 'ws-builder',
    status: 'prepared',
    workspace: { root: '/tmp', group_dir: '/tmp/a', claude_shared_dir: '/tmp/c' },
    files_written: ['CLAUDE.local.md'],
  });
  enqueueProcessMessageOnWorkerMock.mockResolvedValue({ run_id: 'run-1', status: 'accepted' });
  destroyWorkspaceOnWorkerMock.mockResolvedValue(undefined);
  deliverMock.mockResolvedValue(undefined);
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
  });
});

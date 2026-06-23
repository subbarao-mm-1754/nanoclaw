import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from './db/connection.js';
import { processNextPendingInbound } from './processor.js';
import { registerWorkspace } from './store/workspaces.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getOrCreateConversation } from './store/conversations.js';
import { getMessage } from './store/messages.js';
import { countMessagesByStatus } from './store/messages.js';
import { getHttpResponse, saveHttpResponse } from './store/http-responses.js';
import './http-channel.js';

const processMessageOnWorkerMock = vi.fn();

vi.mock('./worker-client.js', () => ({
  processMessageOnWorker: (...args: unknown[]) => processMessageOnWorkerMock(...args),
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
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import {
  continueBuild,
  getBuild,
  handleBuilderRunCallback,
  startBuild,
} from './service.js';
import { parseBuildResultFromText, stripBuildFence } from './parse-result.js';

const prepareWorkspaceOnWorkerMock = vi.fn();
const enqueueProcessMessageOnWorkerMock = vi.fn();
const destroyWorkspaceOnWorkerMock = vi.fn();
const createAgentMock = vi.fn();

vi.mock('../worker-client.js', () => ({
  prepareWorkspaceOnWorker: (...args: unknown[]) => prepareWorkspaceOnWorkerMock(...args),
  enqueueProcessMessageOnWorker: (...args: unknown[]) => enqueueProcessMessageOnWorkerMock(...args),
  destroyWorkspaceOnWorker: (...args: unknown[]) => destroyWorkspaceOnWorkerMock(...args),
  processMessageOnWorker: vi.fn(),
}));

vi.mock('../agent-service.js', () => ({
  createAgent: (...args: unknown[]) => createAgentMock(...args),
}));

beforeEach(() => {
  initGatewayTestDb();
  prepareWorkspaceOnWorkerMock.mockReset();
  enqueueProcessMessageOnWorkerMock.mockReset();
  destroyWorkspaceOnWorkerMock.mockReset();
  createAgentMock.mockReset();

  prepareWorkspaceOnWorkerMock.mockResolvedValue({
    workspace_id: 'ws-builder',
    status: 'prepared',
    workspace: { root: '/tmp', group_dir: '/tmp/agent', claude_shared_dir: '/tmp/.claude' },
    files_written: ['CLAUDE.local.md'],
  });
  enqueueProcessMessageOnWorkerMock.mockResolvedValue({ run_id: 'run-1', status: 'accepted' });
  destroyWorkspaceOnWorkerMock.mockResolvedValue(undefined);
  createAgentMock.mockImplementation(async (input: { name: string; owner_user_id: string }) => ({
    workspace_id: 'ws-result',
    agent_group_id: 'ag-result',
    name: input.name,
    is_default: false,
    owner_user_id: input.owner_user_id,
    folder: 'result',
    cli_scope: 'group',
    container_config: null,
    files: [{ path: 'CLAUDE.local.md', content: '# hi' }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
});

afterEach(() => {
  closeGatewayDb();
});

describe('parseBuildResultFromText', () => {
  it('parses needs_input fence', () => {
    const text = `Which CRM?\n\n\`\`\`nanoclaw-build\n{"status":"needs_input"}\n\`\`\``;
    expect(parseBuildResultFromText(text)).toEqual({ status: 'needs_input' });
    expect(stripBuildFence(text)).toBe('Which CRM?');
  });

  it('parses completed fence with files', () => {
    const text = `\`\`\`nanoclaw-build
{"status":"completed","agent_name":"CRM Bot","files":[{"path":"CLAUDE.local.md","content":"x"}]}
\`\`\``;
    const parsed = parseBuildResultFromText(text);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.agent_name).toBe('CRM Bot');
    expect(parsed?.files?.[0]?.path).toBe('CLAUDE.local.md');
  });

  it('parses completed fence even when file content contains nested triple backticks', () => {
    const text = `Registering now.

\`\`\`nanoclaw-build
{
  "status": "completed",
  "agent_name": "ASCII Artist",
  "files": [
    {
      "path": "CLAUDE.local.md",
      "content": "# ASCII Artist\\n\\nCat:\\n\`\`\`\\n /\\\\_/\\\\\\n( o.o )\\n > ^ <\\n\`\`\`\\n\\nDone.\\n"
    }
  ]
}
\`\`\``;
    const parsed = parseBuildResultFromText(text);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.agent_name).toBe('ASCII Artist');
    expect(parsed?.files?.[0]?.content).toContain('Cat:');
    expect(parsed?.files?.[0]?.content).toContain('```');
  });
});
describe('builder service', () => {
  it('starts a build job and enqueues an async worker run', async () => {
    const user = createUser({
      email: 'builder@example.com',
      password: 'password123',
      display_name: 'Builder',
    });

    const job = await startBuild(user, { message: 'Build a CRM agent' });

    expect(job.id.startsWith('job-')).toBe(true);
    expect(job.status).toBe('in_progress');
    expect(job.builder_workspace_id).toBe(`ws-builder-${user.id}`);
    expect(job.messages).toHaveLength(1);
    expect(job.messages[0]?.role).toBe('user');
    expect(job.runs).toHaveLength(1);
    expect(job.runs[0]?.status).toBe('running');
    expect(prepareWorkspaceOnWorkerMock).toHaveBeenCalled();
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();

    const enqueueArg = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0] as {
      build_job_id: string;
      job_id: string;
    };
    expect(enqueueArg.build_job_id).toBe(job.id);
    expect(enqueueArg.job_id).toBe(job.runs[0]!.id);
  });

  it('moves to waiting_for_user on needs_input callback', async () => {
    const user = createUser({
      email: 'wait@example.com',
      password: 'password123',
      display_name: 'Wait',
    });
    const job = await startBuild(user, { message: 'Build something' });
    const runId = job.runs[0]!.id;

    await handleBuilderRunCallback({
      job_id: runId,
      build_job_id: job.id,
      status: 'completed',
      workspace_id: job.builder_workspace_id,
      session: { id: job.builder_session_id, agent_group_id: job.builder_agent_group_id },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: job.messages[0]!.id,
      outbound: [
        {
          id: 'out-1',
          kind: 'chat',
          channel_type: 'http',
          platform_id: user.id,
          thread_id: job.id,
          content: {
            text: `Which CRM?\n\n\`\`\`nanoclaw-build\n{"status":"needs_input"}\n\`\`\``,
          },
        },
      ],
    });

    const updated = getBuild(user, job.id);
    expect(updated.status).toBe('waiting_for_user');
    expect(updated.messages.some((m) => m.role === 'builder')).toBe(true);
    expect(destroyWorkspaceOnWorkerMock).not.toHaveBeenCalled();
  });

  it('continues a waiting build and completes with agent files', async () => {
    const user = createUser({
      email: 'done@example.com',
      password: 'password123',
      display_name: 'Done',
    });
    const job = await startBuild(user, { message: 'Build CRM' });
    const run1 = job.runs[0]!.id;

    await handleBuilderRunCallback({
      job_id: run1,
      build_job_id: job.id,
      status: 'completed',
      workspace_id: job.builder_workspace_id,
      session: { id: job.builder_session_id, agent_group_id: job.builder_agent_group_id },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 'x',
      outbound: [
        {
          id: 'out-1',
          kind: 'chat',
          channel_type: 'http',
          platform_id: user.id,
          thread_id: job.id,
          content: { text: '```nanoclaw-build\n{"status":"needs_input"}\n```' },
        },
      ],
    });

    const continued = await continueBuild(user, job.id, { message: 'HubSpot' });
    expect(continued.status).toBe('in_progress');
    expect(continued.runs).toHaveLength(2);

    const run2 = continued.runs[1]!.id;
    await handleBuilderRunCallback({
      job_id: run2,
      build_job_id: job.id,
      status: 'completed',
      workspace_id: job.builder_workspace_id,
      session: { id: job.builder_session_id, agent_group_id: job.builder_agent_group_id },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 'y',
      outbound: [
        {
          id: 'out-2',
          kind: 'chat',
          channel_type: 'http',
          platform_id: user.id,
          thread_id: job.id,
          content: {
            text: `\`\`\`nanoclaw-build
{"status":"completed","agent_name":"HubSpot Agent","files":[{"path":"CLAUDE.local.md","content":"# HubSpot"}]}
\`\`\``,
          },
        },
      ],
    });

    const done = getBuild(user, job.id);
    expect(done.status).toBe('completed');
    expect(done.result_workspace_id).toBe('ws-result');
    expect(createAgentMock).toHaveBeenCalled();
    expect(destroyWorkspaceOnWorkerMock).toHaveBeenCalledWith({
      workspace_id: job.builder_workspace_id,
      session_id: job.builder_session_id,
    });
  });
});

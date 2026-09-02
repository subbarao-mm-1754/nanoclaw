import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import {
  continueBuild,
  draftFilesFromEditTurn,
  getBuild,
  handleBuilderRunCallback,
  normalizeDraftAgentFiles,
  previewMatchesTarget,
  registerBuildFromStoredMessages,
  runPreviewTest,
  saveEdit,
  startBuild,
  startEdit,
} from './service.js';
import { looksLikeEditClaimWithoutFiles, looksLikeRegisterIntent, looksLikeUnregisteredCompletion } from './parse-result.js';
import { parseBuildResultFromText, stripBuildFence } from './parse-result.js';
import { createAgentRecord } from '../store/agents.js';
import { findConversation, setConversationWorkspace } from '../store/conversations.js';
import { listAgentFiles } from '../store/agent-files.js';

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

vi.mock('../agent-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-service.js')>();
  return {
    ...actual,
    createAgent: (...args: unknown[]) => createAgentMock(...args),
  };
});

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

describe('normalizeDraftAgentFiles', () => {
  it('strips current-agent/ so preview loads live agent paths', () => {
    expect(
      normalizeDraftAgentFiles([
        { path: 'current-agent/CLAUDE.local.md', content: '# edited' },
        { path: 'CLAUDE.local.md', content: '# from fence' },
      ]),
    ).toEqual([{ path: 'CLAUDE.local.md', content: '# from fence' }]);
  });

  it('takes only current-agent/ paths from memory patches', () => {
    expect(
      draftFilesFromEditTurn(null, [
        { path: 'CLAUDE.local.md', content: '# editor prompt — ignore' },
        { path: 'current-agent/CLAUDE.local.md', content: '# draft agent' },
      ]),
    ).toEqual([{ path: 'CLAUDE.local.md', content: '# draft agent' }]);
  });

  it('detects edit claims that forgot the files fence', () => {
    expect(
      looksLikeEditClaimWithoutFiles(
        'Done — MoodEmoji will now reply with the emoji plus a short caption. Try it with `/test`.',
      ),
    ).toBe(true);
    expect(
      looksLikeEditClaimWithoutFiles(
        'Done — I have updated the draft. MoodEmoji will now reply with a caption. Try it with `/test hello`.',
      ),
    ).toBe(true);
    expect(
      looksLikeEditClaimWithoutFiles(
        'Which format do you prefer?\n\n```nanoclaw-build\n{"status":"needs_input"}\n```',
      ),
    ).toBe(false);
    expect(
      looksLikeEditClaimWithoutFiles(
        'Updated.\n\n```nanoclaw-build\n{"status":"progress","files":[{"path":"CLAUDE.local.md","content":"x"}]}\n```',
      ),
    ).toBe(false);
    // Must not false-positive on the editor's intro that merely describes the current agent.
    expect(
      looksLikeEditClaimWithoutFiles(
        'MoodEmoji is loaded — it reads text and replies with a mood emoji plus a short caption. What would you like to change?',
      ),
    ).toBe(false);
    expect(
      looksLikeEditClaimWithoutFiles(
        "Just to be clear — I haven't changed MoodEmoji yet. Tell me the change you want and I'll emit the updated file.",
      ),
    ).toBe(false);
  });

  it('detects create registration claims and register intents', () => {
    expect(
      looksLikeUnregisteredCompletion(
        'Submitting the registration for SoloAssistant now — the completed definition is in the block below.',
      ),
    ).toBe(true);
    expect(
      looksLikeUnregisteredCompletion(
        'Registering SoloAssistant now. Once created, the Gateway will send the authorize link.',
      ),
    ).toBe(true);
    expect(
      looksLikeUnregisteredCompletion(
        "Not yet — the agent isn't built. Nothing is registered until I emit a completed build.",
      ),
    ).toBe(false);
    expect(looksLikeUnregisteredCompletion('Which CRM do you use?')).toBe(false);
    expect(looksLikeRegisterIntent('Register it now')).toBe(true);
    expect(looksLikeRegisterIntent('/register')).toBe(true);
    expect(looksLikeRegisterIntent('create the agent')).toBe(true);
    expect(looksLikeRegisterIntent('What is the last contact created?')).toBe(false);
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

  it('continues a waiting build then registers via /register', async () => {
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

    const ready = getBuild(user, job.id);
    expect(ready.status).toBe('waiting_for_user');
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(ready.messages.some((m) => m.content.ready_to_register === true)).toBe(true);
    expect(destroyWorkspaceOnWorkerMock).not.toHaveBeenCalled();

    const done = await registerBuildFromStoredMessages(user, job.id);
    expect(done.status).toBe('completed');
    expect(done.result_workspace_id).toBe('ws-result');
    expect(createAgentMock).toHaveBeenCalled();
    expect(destroyWorkspaceOnWorkerMock).toHaveBeenCalledWith({
      workspace_id: job.builder_workspace_id,
      session_id: job.builder_session_id,
    });
  });

  it('defers create registration from memory_patch until /register', async () => {
    const user = createUser({
      email: 'claim-patch@example.com',
      password: 'password123',
      display_name: 'ClaimPatch',
    });
    const job = await startBuild(user, { message: 'create SoloAssistant agent' });
    const run1 = job.runs[0]!.id;
    enqueueProcessMessageOnWorkerMock.mockClear();
    createAgentMock.mockClear();

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
          content: {
            text: 'Submitting the registration for **SoloAssistant** now — the completed definition is in the block below.',
          },
        },
      ],
      memory_patch: {
        files: [{ path: 'CLAUDE.local.md', content: '# SoloAssistant\n\nBusiness ops helper.' }],
      },
    });

    const ready = getBuild(user, job.id);
    expect(ready.status).toBe('waiting_for_user');
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(ready.messages.some((m) => m.content.ready_to_register === true)).toBe(true);

    const done = await registerBuildFromStoredMessages(user, job.id);
    expect(done.status).toBe('completed');
    expect(createAgentMock).toHaveBeenCalled();
    expect(createAgentMock.mock.calls[0]![0].name).toMatch(/SoloAssistant/);
    expect(createAgentMock.mock.calls[0]![0].files[0].content).toContain('Business ops');
  });

  it('marks create not-ready when registration is claimed without files', async () => {
    const user = createUser({
      email: 'claim-nudge@example.com',
      password: 'password123',
      display_name: 'ClaimNudge',
    });
    const job = await startBuild(user, { message: 'create SoloAssistant agent' });
    const run1 = job.runs[0]!.id;
    enqueueProcessMessageOnWorkerMock.mockClear();

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
          content: {
            text: 'Registering **SoloAssistant** now. Watch this chat for the Zoho authorize link.',
          },
        },
      ],
    });

    expect(getBuild(user, job.id).status).toBe('waiting_for_user');
    expect(enqueueProcessMessageOnWorkerMock).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(
      getBuild(user, job.id).messages.some(
        (m) => typeof m.content.text === 'string' && m.content.text.includes('not ready to register'),
      ),
    ).toBe(true);

    await expect(registerBuildFromStoredMessages(user, job.id)).rejects.toThrow(/No agent files/);
  });

  it('registerBuildFromStoredMessages finalizes from an earlier progress files fence', async () => {
    const user = createUser({
      email: 'register-progress@example.com',
      password: 'password123',
      display_name: 'RegProg',
    });
    const job = await startBuild(user, { message: 'Build helper' });
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
          content: {
            text: `Draft ready.\n\n\`\`\`nanoclaw-build
{"status":"progress","agent_name":"Helper","files":[{"path":"CLAUDE.local.md","content":"# Helper"}]}
\`\`\``,
          },
        },
      ],
    });

    expect(getBuild(user, job.id).status).toBe('waiting_for_user');
    createAgentMock.mockClear();

    const registered = await registerBuildFromStoredMessages(user, job.id);
    expect(registered.status).toBe('completed');
    expect(createAgentMock).toHaveBeenCalled();
    expect(createAgentMock.mock.calls[0]![0].name).toBe('Helper');
  });
});

describe('edit + preview test', () => {
  it('starts an edit without binding the delivery chat to the target agent', async () => {
    const user = createUser({
      email: 'edit@example.com',
      password: 'password123',
      display_name: 'Editor',
    });
    const chatAgent = createAgentRecord({
      name: 'Chat Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# chat' }],
    });
    const target = createAgentRecord({
      name: 'Target Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# target original' }],
    });
    setConversationWorkspace({
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-edit',
      thread_id: null,
      workspace_id: chatAgent.workspace_id,
    });

    const job = await startEdit(user, {
      agent: target,
      message: 'Make greetings shorter',
      delivery: {
        channel_type: 'zoho-cliq',
        platform_id: 'zoho-cliq:chat-edit',
        thread_id: null,
      },
    });

    expect(job.job_kind).toBe('edit');
    expect(job.target_workspace_id).toBe(target.workspace_id);
    expect(job.preview_workspace_id).toMatch(/^ws-preview-/);
    expect(findConversation('zoho-cliq', 'zoho-cliq:chat-edit', null)?.workspace_id).toBe(
      chatAgent.workspace_id,
    );
    expect(listAgentFiles(job.preview_workspace_id!).some((f) => f.content.includes('target original'))).toBe(
      true,
    );
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('runs /test against the preview workspace with accumulated file changes', async () => {
    const user = createUser({
      email: 'test-draft@example.com',
      password: 'password123',
      display_name: 'Tester',
    });
    const target = createAgentRecord({
      name: 'CRM',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# original crm' }],
    });

    const job = await startEdit(user, { agent: target, message: 'Be briefer' });
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
          content: {
            text: `\`\`\`nanoclaw-build
{"status":"progress","agent_name":"CRM","files":[{"path":"CLAUDE.local.md","content":"# edited crm"}]}
\`\`\``,
          },
        },
      ],
    });

    expect(listAgentFiles(job.preview_workspace_id!).some((f) => f.content.includes('edited crm'))).toBe(
      true,
    );

    enqueueProcessMessageOnWorkerMock.mockClear();
    const tested = await runPreviewTest(user, job.id, { message: 'Say hi' });
    expect(tested.status).toBe('waiting_for_user');

    const enqueueArg = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0] as {
      workspace_id: string;
      session: { agent_group_id: string };
    };
    expect(enqueueArg.workspace_id).toBe(job.preview_workspace_id);
    expect(enqueueArg.session.agent_group_id).toBe(job.preview_agent_group_id);

    const testRunId = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0].job_id as string;
    await handleBuilderRunCallback({
      job_id: testRunId,
      build_job_id: job.id,
      status: 'completed',
      workspace_id: job.preview_workspace_id!,
      session: { id: job.preview_session_id!, agent_group_id: job.preview_agent_group_id! },
      workspace: { root: '', group_dir: '', claude_shared_dir: '' },
      session_paths: { inbound_db: '', outbound_db: '' },
      inbound_message_id: 't1',
      outbound: [
        {
          id: 'tout-1',
          kind: 'chat',
          channel_type: 'http',
          platform_id: user.id,
          thread_id: job.id,
          content: { text: 'hi from draft' },
        },
      ],
    });

    const afterTest = getBuild(user, job.id);
    expect(afterTest.status).toBe('waiting_for_user');
    expect(afterTest.messages.some((m) => String(m.content.text ?? '').includes('hi from draft'))).toBe(
      true,
    );
  });

  it('saves the draft onto the live agent without switching a bound Cliq chat', async () => {
    const user = createUser({
      email: 'save-edit@example.com',
      password: 'password123',
      display_name: 'Saver',
    });
    const chatAgent = createAgentRecord({
      name: 'Inbox',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# inbox' }],
    });
    const target = createAgentRecord({
      name: 'Writer',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# writer original' }],
    });
    setConversationWorkspace({
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-save',
      thread_id: null,
      workspace_id: chatAgent.workspace_id,
    });

    const job = await startEdit(user, {
      agent: target,
      delivery: {
        channel_type: 'zoho-cliq',
        platform_id: 'zoho-cliq:chat-save',
        thread_id: null,
      },
    });
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
          channel_type: 'zoho-cliq',
          platform_id: 'zoho-cliq:chat-save',
          thread_id: null,
          content: {
            text: `\`\`\`nanoclaw-build
{"status":"completed","agent_name":"Writer","files":[{"path":"CLAUDE.local.md","content":"# writer edited"}]}
\`\`\``,
          },
        },
      ],
    });

    const done = getBuild(user, job.id);
    expect(done.status).toBe('completed');
    expect(done.result_workspace_id).toBe(target.workspace_id);
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(listAgentFiles(target.workspace_id).some((f) => f.content.includes('writer edited'))).toBe(true);
    expect(findConversation('zoho-cliq', 'zoho-cliq:chat-save', null)?.workspace_id).toBe(
      chatAgent.workspace_id,
    );
  });

  it('maps current-agent memory patches onto the preview root before /test', async () => {
    const user = createUser({
      email: 'patch-draft@example.com',
      password: 'password123',
      display_name: 'Patch',
    });
    const target = createAgentRecord({
      name: 'Mailer',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# original mailer' }],
    });

    const job = await startEdit(user, { agent: target, message: 'Be witty' });
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
          content: { text: 'Updated under current-agent.\n\n```nanoclaw-build\n{"status":"needs_input"}\n```' },
        },
      ],
      memory_patch: {
        files: [
          { path: 'CLAUDE.local.md', content: '# editor instructions — must not replace draft' },
          { path: 'current-agent/CLAUDE.local.md', content: '# witty mailer draft' },
        ],
      },
    });

    const previewFiles = listAgentFiles(job.preview_workspace_id!);
    expect(previewFiles.some((f) => f.path === 'CLAUDE.local.md' && f.content.includes('witty mailer'))).toBe(
      true,
    );
    expect(previewFiles.some((f) => f.path.startsWith('current-agent/'))).toBe(false);

    enqueueProcessMessageOnWorkerMock.mockClear();
    await runPreviewTest(user, job.id, { message: 'Write a subject line' });
    const prepareCalls = prepareWorkspaceOnWorkerMock.mock.calls.map((c) => c[0] as {
      workspace_id: string;
      agent: { files: Array<{ path: string; content: string }> };
      options?: { replace?: boolean };
    });
    const previewPrepares = prepareCalls.filter((c) => c.workspace_id === job.preview_workspace_id);
    expect(previewPrepares.length).toBeGreaterThan(0);
    const lastPreview = previewPrepares[previewPrepares.length - 1]!;
    expect(lastPreview.options?.replace).toBe(true);
    expect(
      lastPreview.agent.files.some(
        (f) => f.path === 'CLAUDE.local.md' && f.content.includes('witty mailer'),
      ),
    ).toBe(true);
  });

  it('refuses /test and nudges the editor when the draft is still unchanged', async () => {
    const user = createUser({
      email: 'unchanged-draft@example.com',
      password: 'password123',
      display_name: 'Unchanged',
    });
    const target = createAgentRecord({
      name: 'MoodEmoji',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# emoji only' }],
    });

    const job = await startEdit(user, { agent: target, message: 'Add captions' });
    const run1 = job.runs[0]!.id;
    enqueueProcessMessageOnWorkerMock.mockClear();

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
          content: {
            text: 'Done — I have updated the draft. MoodEmoji will now reply with a caption. Try it with `/test hello`.',
          },
        },
      ],
    });

    expect(previewMatchesTarget(getBuild(user, job.id))).toBe(true);
    // Auto-nudge should enqueue another builder turn to emit files.
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();
    const nudgeRunId = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0].job_id as string;

    enqueueProcessMessageOnWorkerMock.mockClear();
    await handleBuilderRunCallback({
      job_id: nudgeRunId,
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
            text: 'Which caption style?\n\n```nanoclaw-build\n{"status":"needs_input"}\n```',
          },
        },
      ],
    });

    expect(getBuild(user, job.id).status).toBe('waiting_for_user');
    expect(previewMatchesTarget(getBuild(user, job.id))).toBe(true);

    enqueueProcessMessageOnWorkerMock.mockClear();
    await expect(runPreviewTest(user, job.id, { message: 'saying hello to a friend' })).rejects.toThrow(
      /Draft still matches the original agent/,
    );
  });

  it('allows /test on an unchanged draft when the editor only asked a question', async () => {
    const user = createUser({
      email: 'baseline-test@example.com',
      password: 'password123',
      display_name: 'Baseline',
    });
    const target = createAgentRecord({
      name: 'MoodEmoji',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# emoji plus caption' }],
    });

    const job = await startEdit(user, { agent: target });
    const run1 = job.runs[0]!.id;
    enqueueProcessMessageOnWorkerMock.mockClear();

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
          content: {
            text: 'MoodEmoji is loaded — it reads text and replies with a mood emoji plus a short caption. What would you like to change?',
          },
        },
      ],
    });

    expect(previewMatchesTarget(getBuild(user, job.id))).toBe(true);
    // Spurious "emit files" nudge must not fire on a question-only intro.
    expect(enqueueProcessMessageOnWorkerMock).not.toHaveBeenCalled();

    const tested = await runPreviewTest(user, job.id, { message: 'saying hello' });
    expect(tested.runs.some((r) => r.kind === 'test')).toBe(true);
    expect(enqueueProcessMessageOnWorkerMock).toHaveBeenCalled();
    const enqueueArg = enqueueProcessMessageOnWorkerMock.mock.calls[0]![0] as {
      workspace_id: string;
    };
    expect(enqueueArg.workspace_id).toBe(job.preview_workspace_id);
  });

  it('applies current preview files on saveEdit', async () => {
    const user = createUser({
      email: 'save-cmd@example.com',
      password: 'password123',
      display_name: 'SaveCmd',
    });
    const target = createAgentRecord({
      name: 'Notes',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# notes' }],
    });
    const job = await startEdit(user, { agent: target });
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
          content: {
            text: `\`\`\`nanoclaw-build
{"status":"needs_input","files":[{"path":"CLAUDE.local.md","content":"# notes v2"}]}
\`\`\``,
          },
        },
      ],
    });

    const saved = await saveEdit(user, job.id);
    expect(saved.status).toBe('completed');
    expect(listAgentFiles(target.workspace_id).some((f) => f.content.includes('notes v2'))).toBe(true);
  });
});

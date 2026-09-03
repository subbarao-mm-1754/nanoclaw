import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openInboundDb, writeOutboundDirect } from '../session-manager.js';
import { runProcessMessageJob } from './job-runner.js';
import { runPrepareWorkspace } from './prepare-workspace.js';
import { parseMultipartBody } from './multipart.js';
import {
  mergeAgentFiles,
  parsePrepareWorkspaceRequest,
  parseProcessMessageRequest,
  WorkerValidationError,
} from './validate.js';
import { materializeWorkspace } from './workspace-materializer.js';
import { startWorkerServer, stopWorkerServer } from './server.js';
import { collectOutboundMessages } from './outbound-collector.js';
import { captureMemoryBaseline, collectMemoryPatch } from './memory-sync.js';
import { loadWorkspaceManifest, saveWorkspaceManifest } from './workspace-store.js';
import { WORKER_PORT } from '../config.js';
import type { WorkerWorkspaceManifest } from './types.js';

vi.mock('../skill-symlinks.js', () => ({
  syncSkillSymlinks: vi.fn(),
}));

const wakeContainerMock = vi.fn();
const isContainerRunningMock = vi.fn();

vi.mock('../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeContainerMock(...args),
  isContainerRunning: (...args: unknown[]) => isContainerRunningMock(...args),
  waitForContainerStop: vi.fn().mockResolvedValue(true),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-worker',
    WORKER_HOST: '127.0.0.1',
    WORKER_PORT: 18080,
    WORKER_AUTH_TOKEN: '',
    WORKER_JOB_TIMEOUT_MS: 5000,
    WORKER_CLEANUP_WORKSPACE: false,
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-worker';
const WORKSPACE_ID = 'ws-test-1';
const AGENT_GROUP_ID = 'ag-test-1';

function sampleManifest(overrides: Partial<WorkerWorkspaceManifest> = {}): WorkerWorkspaceManifest {
  const now = new Date().toISOString();
  return {
    workspace_id: WORKSPACE_ID,
    agent_group_id: AGENT_GROUP_ID,
    name: 'Test Agent',
    folder: 'test-agent',
    container_config: {
      provider: 'claude',
      skills: 'all',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
    },
    cli_scope: 'group',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function samplePrepareBody(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: WORKSPACE_ID,
    agent: {
      agent_group_id: AGENT_GROUP_ID,
      name: 'Test Agent',
      folder: 'test-agent',
      container_config: {
        provider: 'claude',
        skills: 'all',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
      },
      files: [
        { path: 'CLAUDE.local.md', content: 'You are a helpful assistant.' },
        { path: 'notes/readme.md', content: '# Notes' },
      ],
    },
    ...overrides,
  };
}

function sampleProcessBody(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-test-1',
    workspace_id: WORKSPACE_ID,
    session: { id: 'sess-test-1', agent_group_id: AGENT_GROUP_ID },
    delivery: { channel_type: 'http', platform_id: 'client-1', thread_id: null },
    inbound: {
      id: 'msg-1',
      kind: 'chat',
      timestamp: '2026-06-05T12:00:00Z',
      content: { text: 'Hello' },
      sender: { id: 'user:1', display_name: 'Test User' },
    },
    options: { run_container: false },
    ...overrides,
  };
}

function prepareTestWorkspace() {
  return runPrepareWorkspace(parsePrepareWorkspaceRequest(samplePrepareBody()));
}

beforeEach(() => {
  wakeContainerMock.mockReset();
  isContainerRunningMock.mockReset();
  isContainerRunningMock.mockReturnValue(false);
  wakeContainerMock.mockResolvedValue(true);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await stopWorkerServer();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('parsePrepareWorkspaceRequest', () => {
  it('accepts a valid payload with files', () => {
    const req = parsePrepareWorkspaceRequest(samplePrepareBody());
    expect(req.workspace_id).toBe(WORKSPACE_ID);
    expect(req.agent.files).toHaveLength(2);
    expect(req.agent.files[0].path).toBe('CLAUDE.local.md');
  });

  it('rejects missing workspace_id', () => {
    const body = samplePrepareBody();
    delete (body as { workspace_id?: string }).workspace_id;
    expect(() => parsePrepareWorkspaceRequest(body)).toThrow(WorkerValidationError);
  });

  it('requires at least one file source', () => {
    const body = samplePrepareBody();
    delete (body.agent as { files?: unknown }).files;
    expect(() => parsePrepareWorkspaceRequest(body)).toThrow(WorkerValidationError);
  });

  it('accepts content_base64 file entries', () => {
    const body = samplePrepareBody({
      agent: {
        ...samplePrepareBody().agent,
        files: [{ path: 'notes/x.md', content_base64: Buffer.from('# Hi').toString('base64') }],
      },
    });
    const req = parsePrepareWorkspaceRequest(body);
    expect(req.agent.files[0].content).toBeInstanceOf(Buffer);
  });

  it('reads container_config.mcpServers, not the whole agent object', () => {
    const body = samplePrepareBody({
      agent: {
        ...samplePrepareBody().agent,
        container_config: {
          ...samplePrepareBody().agent.container_config,
          mcpServers: {
            ZohoMCP: {
              command: 'npx',
              args: ['mcp-remote', 'https://example.test/mcp', '--transport', 'http-only'],
            },
          },
        },
      },
    });
    const req = parsePrepareWorkspaceRequest(body);
    const zoho = req.agent.container_config.mcpServers?.ZohoMCP;
    expect(zoho && 'command' in zoho ? zoho.command : undefined).toBe('npx');
    expect(req.agent.container_config).not.toHaveProperty('agent_group_id');
  });
});

describe('multipart prepare', () => {
  it('parses metadata and file attachments', () => {
    const boundary = 'test-boundary';
    const metadata = JSON.stringify({
      workspace_id: 'ws-mp-1',
      agent: {
        agent_group_id: 'ag-mp-1',
        name: 'Multipart Agent',
        container_config: samplePrepareBody().agent.container_config,
      },
    });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="metadata"\r\n\r\n' +
          `${metadata}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="CLAUDE.local.md"\r\n' +
          'Content-Type: text/markdown\r\n\r\n' +
          '# Memory\r\n' +
          'Hello from attachment\r\n',
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const parsed = parseMultipartBody(body, boundary);
    const req = parsePrepareWorkspaceRequest(parsed.metadata, parsed.attachments);
    expect(req.workspace_id).toBe('ws-mp-1');
    expect(req.agent.files).toHaveLength(1);
    expect(req.agent.files[0].path).toBe('CLAUDE.local.md');
    expect(Buffer.isBuffer(req.agent.files[0].content)).toBe(true);
    expect(req.agent.files[0].content.toString()).toContain('Hello from attachment');
  });

  it('merges inline files with attachments (attachments win)', () => {
    const merged = mergeAgentFiles(
      [{ path: 'a.md', content: 'inline' }],
      [{ path: 'a.md', content: Buffer.from('attached') }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].content.toString()).toBe('attached');
  });
});

describe('parseProcessMessageRequest', () => {
  it('accepts a valid payload without agent config', () => {
    const job = parseProcessMessageRequest(sampleProcessBody());
    expect(job.workspace_id).toBe(WORKSPACE_ID);
    expect(job.options?.run_container).toBe(false);
  });

  it('rejects missing workspace_id', () => {
    const body = sampleProcessBody();
    delete (body as { workspace_id?: string }).workspace_id;
    expect(() => parseProcessMessageRequest(body)).toThrow(WorkerValidationError);
  });
});

describe('runPrepareWorkspace', () => {
  it('writes files at provided paths and persists manifest', () => {
    const result = prepareTestWorkspace();

    expect(result.status).toBe('prepared');
    expect(result.files_written).toContain('CLAUDE.local.md');
    expect(result.files_written).toContain('notes/readme.md');
    expect(fs.readFileSync(path.join(result.workspace.group_dir, 'CLAUDE.local.md'), 'utf8')).toContain(
      'helpful assistant',
    );
    expect(fs.existsSync(path.join(result.workspace.group_dir, 'container.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspace.group_dir, 'CLAUDE.md'))).toBe(true);

    const manifest = loadWorkspaceManifest(WORKSPACE_ID);
    expect(manifest.agent_group_id).toBe(AGENT_GROUP_ID);
    expect(manifest.container_config).not.toHaveProperty('agent_group_id');
  });

  it('materializes mcpServers into container.json', () => {
    const result = runPrepareWorkspace(
      parsePrepareWorkspaceRequest(
        samplePrepareBody({
          agent: {
            ...samplePrepareBody().agent,
            container_config: {
              ...samplePrepareBody().agent.container_config,
              mcpServers: {
                ZohoMCP: {
                  command: 'npx',
                  args: ['mcp-remote', 'https://example.test/mcp'],
                },
              },
            },
          },
        }),
      ),
    );
    const containerJson = JSON.parse(
      fs.readFileSync(path.join(result.workspace.group_dir, 'container.json'), 'utf8'),
    );
    expect(containerJson.mcpServers.ZohoMCP.command).toBe('npx');
  });

  it('rejects duplicate workspace without replace', () => {
    prepareTestWorkspace();
    expect(() => prepareTestWorkspace()).toThrow(WorkerValidationError);
  });

  it('replaces workspace when options.replace is true', () => {
    prepareTestWorkspace();
    const result = runPrepareWorkspace(
      parsePrepareWorkspaceRequest(
        samplePrepareBody({
          agent: {
            ...samplePrepareBody().agent,
            files: [{ path: 'CLAUDE.local.md', content: 'Replaced content.' }],
          },
          options: { replace: true },
        }),
      ),
    );
    expect(fs.readFileSync(path.join(result.workspace.group_dir, 'CLAUDE.local.md'), 'utf8')).toBe(
      'Replaced content.',
    );
  });
});

describe('materializeWorkspace', () => {
  it('writes provided files under group dir', () => {
    const manifest = sampleManifest();
    saveWorkspaceManifest(manifest);
    const result = materializeWorkspace(manifest, [{ path: 'subdir/foo.txt', content: 'bar' }]);
    expect(fs.readFileSync(path.join(result.group_dir, 'subdir/foo.txt'), 'utf8')).toBe('bar');
  });
});

describe('memory-sync', () => {
  it('detects CLAUDE.local.md changes in file patch', () => {
    prepareTestWorkspace();
    const groupDir = path.join(TEST_DIR, 'worker-workspaces', WORKSPACE_ID, 'agent');
    const baseline = captureMemoryBaseline(groupDir);
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'updated memory');
    const patch = collectMemoryPatch(groupDir, baseline);
    expect(patch?.files?.some((f) => f.path === 'CLAUDE.local.md' && f.content === 'updated memory')).toBe(true);
  });
});

describe('collectOutboundMessages', () => {
  it('collects chat messages for the delivery address', async () => {
    prepareTestWorkspace();
    const job = parseProcessMessageRequest(sampleProcessBody());
    await runProcessMessageJob(job);

    writeOutboundDirect(job.session.agent_group_id, job.session.id, {
      id: 'out-1',
      kind: 'chat',
      platformId: job.delivery.platform_id,
      channelType: job.delivery.channel_type,
      threadId: job.delivery.thread_id,
      content: JSON.stringify({ text: 'Hi there' }),
    });

    isContainerRunningMock.mockReturnValue(false);
    const outbound = await collectOutboundMessages({
      workspaceId: job.workspace_id,
      agentGroupId: job.session.agent_group_id,
      sessionId: job.session.id,
      delivery: job.delivery,
      timeoutMs: 500,
    });

    expect(outbound).toHaveLength(1);
    expect(outbound[0].content.text).toBe('Hi there');
  });
});

describe('runProcessMessageJob', () => {
  it('writes inbound message, session routing, and destinations', async () => {
    prepareTestWorkspace();
    const job = parseProcessMessageRequest(sampleProcessBody());
    const result = await runProcessMessageJob(job);

    expect(result.status).toBe('prepared');
    expect(result.workspace_id).toBe(WORKSPACE_ID);
    expect(fs.existsSync(result.session_paths.inbound_db)).toBe(true);

    const db = openInboundDb(job.session.agent_group_id, job.session.id);
    try {
      const row = db.prepare('SELECT * FROM messages_in WHERE id = ?').get(job.inbound.id) as {
        content: string;
        channel_type: string;
      };
      expect(row.channel_type).toBe('http');
      expect(JSON.parse(row.content).text).toBe('Hello');
    } finally {
      db.close();
    }

    expect(wakeContainerMock).not.toHaveBeenCalled();
  });

  it('skips duplicate inbound id without failing', async () => {
    prepareTestWorkspace();
    const job = parseProcessMessageRequest(sampleProcessBody());
    await runProcessMessageJob(job);

    const duplicate = await runProcessMessageJob({
      ...job,
      job_id: 'job-duplicate',
      options: { run_container: false },
    });

    expect(duplicate.status).toBe('prepared');
    const db = openInboundDb(job.session.agent_group_id, job.session.id);
    try {
      const count = db
        .prepare('SELECT COUNT(*) AS c FROM messages_in WHERE id = ?')
        .get(job.inbound.id) as { c: number };
      expect(count.c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('serializes structured inbound content into text when text is omitted', async () => {
    prepareTestWorkspace();
    const job = parseProcessMessageRequest(
      sampleProcessBody({
        inbound: {
          id: 'msg-structured',
          kind: 'chat',
          timestamp: '2026-06-10T15:00:00.000Z',
          content: {
            user: { id: 'user-1', name: 'Ryan' },
            expenses: [{ expense_id: 'EXP-003', amount: 195 }],
          },
        },
      }),
    );
    await runProcessMessageJob(job);

    const db = openInboundDb(job.session.agent_group_id, job.session.id);
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-structured') as {
        content: string;
      };
      const parsed = JSON.parse(row.content) as { text: string; user: { id: string } };
      expect(parsed.text).toContain('EXP-003');
      expect(parsed.user.id).toBe('user-1');
    } finally {
      db.close();
    }
  });

  it('spawns container and returns outbound + memory patch', async () => {
    prepareTestWorkspace();
    const job = parseProcessMessageRequest(
      sampleProcessBody({
        options: { run_container: true, timeout_ms: 3000 },
      }),
    );

    wakeContainerMock.mockImplementation(async (session, spawnContext) => {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: 'out-job-1',
        kind: 'chat',
        platformId: job.delivery.platform_id,
        channelType: job.delivery.channel_type,
        threadId: job.delivery.thread_id,
        content: JSON.stringify({ text: 'Agent reply' }),
      });
      if (spawnContext?.groupDir) {
        fs.writeFileSync(path.join(spawnContext.groupDir, 'CLAUDE.local.md'), 'remember this');
      }
      return true;
    });

    const result = await runProcessMessageJob(job);

    expect(wakeContainerMock).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.outbound).toHaveLength(1);
    expect(result.memory_patch?.files?.some((f) => f.path === 'CLAUDE.local.md')).toBe(true);
  });

  it('fails when workspace does not exist', async () => {
    const job = parseProcessMessageRequest(sampleProcessBody());
    await expect(runProcessMessageJob(job)).rejects.toThrow(WorkerValidationError);
  });

  it('returns failed when container spawn fails', async () => {
    prepareTestWorkspace();
    wakeContainerMock.mockResolvedValue(false);
    const job = parseProcessMessageRequest(sampleProcessBody({ options: { run_container: true } }));
    const result = await runProcessMessageJob(job);
    expect(result.status).toBe('failed');
  });
});

describe('worker HTTP server', () => {
  it('handles health, prepare-workspace, and process-message', async () => {
    await startWorkerServer();

    const health = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
    expect(health.status).toBe(200);

    const prepareRes = await fetch(`http://127.0.0.1:${WORKER_PORT}/v1/workspaces/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        samplePrepareBody({
          workspace_id: 'ws-http-1',
          agent: {
            ...samplePrepareBody().agent,
            agent_group_id: 'ag-http-1',
          },
        }),
      ),
    });
    expect(prepareRes.status).toBe(200);
    const prepareBody = (await prepareRes.json()) as { status: string; workspace_id: string };
    expect(prepareBody.status).toBe('prepared');
    expect(prepareBody.workspace_id).toBe('ws-http-1');

    const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/v1/jobs/process-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        sampleProcessBody({
          job_id: 'job-http-1',
          workspace_id: 'ws-http-1',
          session: { id: 'sess-http-1', agent_group_id: 'ag-http-1' },
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; job_id: string };
    expect(body.status).toBe('prepared');
    expect(body.job_id).toBe('job-http-1');
  });
});

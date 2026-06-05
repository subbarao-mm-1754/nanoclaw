import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openInboundDb, inboundDbPath, writeOutboundDirect } from '../session-manager.js';
import { runWorkerJob } from './job-runner.js';
import { parseWorkerJobRequest, WorkerValidationError } from './validate.js';
import { materializeWorkspace } from './workspace-materializer.js';
import { startWorkerServer, stopWorkerServer } from './server.js';
import { collectOutboundMessages } from './outbound-collector.js';
import { captureMemoryBaseline, collectMemoryPatch } from './memory-sync.js';
import { WORKER_PORT } from '../config.js';

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

function sampleJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-test-1',
    session: { id: 'sess-test-1', agent_group_id: 'ag-test-1' },
    delivery: { channel_type: 'http', platform_id: 'client-1', thread_id: null },
    inbound: {
      id: 'msg-1',
      kind: 'chat',
      timestamp: '2026-06-05T12:00:00Z',
      content: { text: 'Hello' },
      sender: { id: 'user:1', display_name: 'Test User' },
    },
    agent_snapshot: {
      name: 'Test Agent',
      folder: 'test-agent',
      container_config: {
        provider: 'claude',
        skills: 'all',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
      },
      instructions: 'You are a helpful assistant.',
    },
    options: { run_container: false },
    ...overrides,
  };
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

describe('parseWorkerJobRequest', () => {
  it('accepts a valid payload', () => {
    const job = parseWorkerJobRequest(sampleJob());
    expect(job.job_id).toBe('job-test-1');
    expect(job.options?.run_container).toBe(false);
  });

  it('rejects missing job_id', () => {
    const body = sampleJob();
    delete (body as { job_id?: string }).job_id;
    expect(() => parseWorkerJobRequest(body)).toThrow(WorkerValidationError);
  });
});

describe('materializeWorkspace', () => {
  it('writes CLAUDE.local.md and container.json', () => {
    const job = parseWorkerJobRequest(sampleJob());
    const result = materializeWorkspace(job);

    expect(fs.existsSync(path.join(result.groupDir, 'CLAUDE.local.md'))).toBe(true);
    expect(fs.readFileSync(path.join(result.groupDir, 'CLAUDE.local.md'), 'utf8')).toContain('helpful assistant');
    expect(fs.existsSync(path.join(result.groupDir, 'container.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.groupDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.claudeSharedDir, 'settings.json'))).toBe(true);
  });
});

describe('memory-sync', () => {
  it('detects CLAUDE.local.md changes', () => {
    const job = parseWorkerJobRequest(sampleJob());
    const { groupDir } = materializeWorkspace(job);
    const baseline = captureMemoryBaseline(groupDir, 'original');
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'updated memory');
    const patch = collectMemoryPatch(groupDir, baseline);
    expect(patch?.instructions).toBe('updated memory');
  });
});

describe('collectOutboundMessages', () => {
  it('collects chat messages for the delivery address', async () => {
    const job = parseWorkerJobRequest(sampleJob());
    await runWorkerJob(job);

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
      agentGroupId: job.session.agent_group_id,
      sessionId: job.session.id,
      delivery: job.delivery,
      timeoutMs: 500,
    });

    expect(outbound).toHaveLength(1);
    expect(outbound[0].content.text).toBe('Hi there');
  });
});

describe('runWorkerJob', () => {
  it('writes inbound message and session routing', async () => {
    const job = parseWorkerJobRequest(sampleJob());
    const result = await runWorkerJob(job);

    expect(result.status).toBe('prepared');
    expect(fs.existsSync(result.session_paths.inbound_db)).toBe(true);

    const db = openInboundDb(job.session.agent_group_id, job.session.id);
    try {
      const row = db.prepare('SELECT * FROM messages_in WHERE id = ?').get(job.inbound.id) as {
        content: string;
        channel_type: string;
        platform_id: string;
      };
      expect(row.channel_type).toBe('http');
      const content = JSON.parse(row.content);
      expect(content.text).toBe('Hello');
    } finally {
      db.close();
    }

    expect(inboundDbPath(job.session.agent_group_id, job.session.id)).toBe(result.session_paths.inbound_db);
    expect(wakeContainerMock).not.toHaveBeenCalled();
  });

  it('spawns container and returns outbound + memory patch', async () => {
    const job = parseWorkerJobRequest(
      sampleJob({
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

    isContainerRunningMock.mockReturnValue(false);

    const result = await runWorkerJob(job);

    expect(wakeContainerMock).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.outbound).toHaveLength(1);
    expect(result.outbound![0].content.text).toBe('Agent reply');
    expect(result.memory_patch?.instructions).toBe('remember this');
  });

  it('returns failed when container spawn fails', async () => {
    wakeContainerMock.mockResolvedValue(false);
    const job = parseWorkerJobRequest(sampleJob({ options: { run_container: true } }));
    const result = await runWorkerJob(job);
    expect(result.status).toBe('failed');
  });
});

describe('worker HTTP server', () => {
  it('handles health and process-message', async () => {
    await startWorkerServer();

    const health = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
    expect(health.status).toBe(200);

    const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/v1/jobs/process-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        sampleJob({
          job_id: 'job-http-1',
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

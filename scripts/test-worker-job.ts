#!/usr/bin/env tsx
/**
 * Send a sample job to a running NanoClaw worker (Phases A–C).
 *
 * Usage:
 *   pnpm worker:dev          # terminal 1
 *   pnpm exec tsx scripts/test-worker-job.ts   # terminal 2
 */
const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:8080';
const AUTH = process.env.WORKER_AUTH_TOKEN;

const payload = {
  job_id: `job-manual-${Date.now()}`,
  session: { id: `sess-manual-${Date.now()}`, agent_group_id: 'ag-manual-1' },
  delivery: { channel_type: 'http', platform_id: 'client-manual', thread_id: null },
  inbound: {
    id: `msg-${Date.now()}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: { text: 'Hello from test-worker-job script' },
    sender: { id: 'user:manual', display_name: 'Manual Tester' },
  },
  agent_snapshot: {
    name: 'Manual Test Agent',
    container_config: {
      provider: 'claude',
      skills: 'all',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
    },
    instructions: 'You are a helpful assistant for manual worker testing.',
  },
};

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = `Bearer ${AUTH}`;

const res = await fetch(`${WORKER_URL}/v1/jobs/process-message`, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}

if (!res.ok) process.exit(1);

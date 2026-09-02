#!/usr/bin/env tsx
/**
 * Send a sample prepare + process-message flow to a running NanoClaw worker.
 *
 * Usage:
 *   pnpm worker:dev          # terminal 1
 *   pnpm exec tsx scripts/test-worker-job.ts   # terminal 2
 *
 * Set WORKER_SKIP_ONECLI=true for local runs without OneCLI (agent API calls may fail).
 * Set options.run_container=false on the process-message step to test session prep only.
 */
const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:8080';
const AUTH = process.env.WORKER_AUTH_TOKEN;

const workspaceId = process.env.WORKER_TEST_WORKSPACE_ID || `ws-manual-${Date.now()}`;
const agentGroupId = process.env.WORKER_TEST_AGENT_GROUP_ID || 'ag-manual-1';
const sessionId = process.env.WORKER_TEST_SESSION_ID || `sess-manual-${Date.now()}`;

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = `Bearer ${AUTH}`;

const preparePayload = {
  workspace_id: workspaceId,
  agent: {
    agent_group_id: agentGroupId,
    name: 'Manual Test Agent',
    container_config: {
      provider: 'claude',
      skills: 'all',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
    },
    files: [
      {
        path: 'CLAUDE.local.md',
        content: 'You are a helpful assistant for manual worker testing.',
      },
    ],
  },
  options: { replace: true },
};

console.log('POST /v1/workspaces/prepare');
const prepareRes = await fetch(`${WORKER_URL}/v1/workspaces/prepare`, {
  method: 'POST',
  headers,
  body: JSON.stringify(preparePayload),
});
const prepareText = await prepareRes.text();
console.log(`HTTP ${prepareRes.status}`);
try {
  console.log(JSON.stringify(JSON.parse(prepareText), null, 2));
} catch {
  console.log(prepareText);
}
if (!prepareRes.ok) process.exit(1);

const processPayload = {
  job_id: `job-manual-${Date.now()}`,
  workspace_id: workspaceId,
  session: { id: sessionId, agent_group_id: agentGroupId },
  delivery: { channel_type: 'http', platform_id: 'client-manual', thread_id: null },
  inbound: {
    id: `msg-${Date.now()}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: { text: 'Hello from test-worker-job script' },
    sender: { id: 'user:manual', display_name: 'Manual Tester' },
  },
  options: {
    run_container: process.env.WORKER_TEST_RUN_CONTAINER !== 'false',
  },
};

console.log('\nPOST /v1/jobs/process-message');
const res = await fetch(`${WORKER_URL}/v1/jobs/process-message`, {
  method: 'POST',
  headers,
  body: JSON.stringify(processPayload),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}

if (!res.ok) process.exit(1);

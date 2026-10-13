import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    AUTO_AGENT_ROUTE: true,
    LAYA_CONFIDENCE_MIN: 0.55,
    LAYA_PROBABILITY_MIN: 0.4,
    LAYA_OLLAMA_URL: 'http://127.0.0.1:11434',
    LAYA_MODEL: 'laya',
  };
});

const safeLayaChoiceMock = vi.fn();

vi.mock('./laya-client.js', () => ({
  safeLayaChoice: (...args: unknown[]) => safeLayaChoiceMock(...args),
}));

import {
  applyAutoAgentRoute,
  buildLayaAgentCriteria,
  selectRoutableAgents,
} from './auto-route.js';
import {
  estimateLayaTokens,
  LAYA_OPTION_TOKEN_LIMIT,
  LAYA_OPTIONS_TOTAL_LIMIT,
} from './routing-description.js';
import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createAgentRecord } from '../store/agents.js';
import { createUser } from '../store/users.js';
import { getOrCreateConversation, findConversation } from '../store/conversations.js';
import { enqueueInboundMessage } from '../store/messages.js';
import { listUserAgents } from '../store/agent-select.js';
import { getMasterWorkspaceForUser } from '../store/workspaces.js';
import type { GatewayWorkspace } from '../types.js';

describe('auto agent route', () => {
  beforeEach(() => {
    closeGatewayDb();
    initGatewayTestDb();
    safeLayaChoiceMock.mockReset();
  });

  afterEach(() => {
    closeGatewayDb();
  });

  it('uses short Laya option keys under the 48-token limit', () => {
    const user = createUser({
      email: 'keys@test.com',
      password: 'password123',
      display_name: 'Keys',
    });
    const master = getMasterWorkspaceForUser(user.id)!;
    createAgentRecord({
      name: 'Billing',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# Billing\n\nHandles invoices and refunds.\n' }],
      routing_description:
        'Billing — invoices, payments, refunds, subscription charges, and duplicate billing disputes',
    });
    const agents = selectRoutableAgents(listUserAgents(user.id), master.workspace_id);
    const { criteria, keyToWorkspaceId } = buildLayaAgentCriteria(
      agents,
      master.workspace_id,
    );
    expect(Object.keys(criteria).every((k) => /^a\d+$/.test(k))).toBe(true);
    let total = 0;
    for (const [key, value] of Object.entries(criteria)) {
      expect(estimateLayaTokens(value)).toBeLessThanOrEqual(LAYA_OPTION_TOKEN_LIMIT);
      total += estimateLayaTokens(key) + estimateLayaTokens(value);
    }
    expect(total).toBeLessThanOrEqual(LAYA_OPTIONS_TOTAL_LIMIT);
    expect([...keyToWorkspaceId.values()]).toContain(master.workspace_id);
    expect(keyToWorkspaceId.get('a0')).toBe(master.workspace_id);
  });

  it('selectRoutableAgents always includes current and master', () => {
    const agents = [
      {
        workspace_id: 'ws-a',
        name: 'A',
        is_master: false,
        updated_at: '2020-01-01T00:00:00.000Z',
      },
      {
        workspace_id: 'ws-m',
        name: 'Master',
        is_master: true,
        updated_at: '2020-01-02T00:00:00.000Z',
      },
      {
        workspace_id: 'ws-b',
        name: 'B',
        is_master: false,
        updated_at: '2020-01-03T00:00:00.000Z',
      },
    ] as GatewayWorkspace[];

    const picked = selectRoutableAgents(agents, 'ws-a');
    expect(picked.map((a) => a.workspace_id)).toEqual(['ws-a', 'ws-m', 'ws-b']);
  });

  it('sticky-switches conversation when Laya is confident', async () => {
    const user = createUser({
      email: 'route@test.com',
      password: 'password123',
      display_name: 'Route',
    });
    const master = getMasterWorkspaceForUser(user.id)!;
    const billing = createAgentRecord({
      name: 'Billing',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# Billing\n\nHandles invoices and refunds.\n' }],
      routing_description: 'Billing — invoices, payments, refunds',
    });

    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: `http-${user.id}`,
      thread_id: null,
      workspace_id: master.workspace_id,
    });

    const inbound = enqueueInboundMessage(
      {
        id: 'in-1',
        channel_type: 'http',
        platform_id: conv.platform_id,
        thread_id: null,
        kind: 'chat',
        content: { text: 'Please refund my March invoice' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    safeLayaChoiceMock.mockResolvedValue({
      type: 'choice',
      choice: billing.workspace_id,
      probabilities: {
        [master.workspace_id]: 0.05,
        [billing.workspace_id]: 0.9,
      },
      confidence: 0.85,
    });

    const result = await applyAutoAgentRoute({ conversation: conv, inbound });
    expect(result.switched).toBe(true);
    expect(result.toWorkspaceId).toBe(billing.workspace_id);
    expect(findConversation('http', conv.platform_id, null)?.workspace_id).toBe(
      billing.workspace_id,
    );
  });

  it('stays on current agent when confidence is low', async () => {
    const user = createUser({
      email: 'low@test.com',
      password: 'password123',
      display_name: 'Low',
    });
    const master = getMasterWorkspaceForUser(user.id)!;
    const billing = createAgentRecord({
      name: 'Billing',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# Billing\n' }],
      routing_description: 'Billing — invoices',
    });

    const conv = getOrCreateConversation({
      channel_type: 'http',
      platform_id: `http-${user.id}`,
      thread_id: null,
      workspace_id: master.workspace_id,
    });

    const inbound = enqueueInboundMessage(
      {
        id: 'in-2',
        channel_type: 'http',
        platform_id: conv.platform_id,
        thread_id: null,
        kind: 'chat',
        content: { text: 'hmm maybe?' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    safeLayaChoiceMock.mockResolvedValue({
      type: 'choice',
      choice: billing.workspace_id,
      probabilities: { [billing.workspace_id]: 0.35, [master.workspace_id]: 0.3 },
      confidence: 0.2,
    });

    const result = await applyAutoAgentRoute({ conversation: conv, inbound });
    expect(result.switched).toBe(false);
    expect(result.reason).toBe('low_confidence');
    expect(findConversation('http', conv.platform_id, null)?.workspace_id).toBe(
      master.workspace_id,
    );
  });
});

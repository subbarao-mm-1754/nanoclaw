import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    AUTO_AGENT_ROUTE: true,
    DECISION_CONFIDENCE_MIN: 0.55,
    DECISION_PROBABILITY_MIN: 0.4,
    DECISION_MODEL_URL: 'http://127.0.0.1:11434',
    DECISION_MODEL: 'clef-flash',
    DECISION_OPTION_TOKEN_LIMIT: 256,
    DECISION_OPTIONS_TOTAL_LIMIT: 4096,
    DECISION_MESSAGE_CHARS: 4000,
    DECISION_MAX_AGENTS: 20,
    DECISION_ROUTING_BLURB_CHARS: 400,
    DECISION_HISTORY_MESSAGES: 6,
    DECISION_HISTORY_CHARS: 3000,
  };
});

const safeDecisionChoiceMock = vi.fn();

vi.mock('./decision-client.js', () => ({
  safeDecisionChoice: (...args: unknown[]) => safeDecisionChoiceMock(...args),
}));

import {
  applyAutoAgentRoute,
  buildAgentCriteria,
  selectRoutableAgents,
} from './auto-route.js';
import {
  DECISION_OPTION_TOKEN_LIMIT,
  DECISION_OPTIONS_TOTAL_LIMIT,
} from '../../config.js';
import { estimateDecisionTokens } from './routing-description.js';
import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createAgentRecord } from '../store/agents.js';
import { createUser } from '../store/users.js';
import { getOrCreateConversation, findConversation } from '../store/conversations.js';
import { enqueueInboundMessage, insertOutboundMessage } from '../store/messages.js';
import { listUserAgents } from '../store/agent-select.js';
import { getMasterWorkspaceForUser } from '../store/workspaces.js';
import type { GatewayWorkspace } from '../types.js';

describe('auto agent route', () => {
  beforeEach(() => {
    closeGatewayDb();
    initGatewayTestDb();
    safeDecisionChoiceMock.mockReset();
  });

  afterEach(() => {
    closeGatewayDb();
  });

  it('uses short option keys under the configured token budgets', () => {
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
    const { criteria, keyToWorkspaceId } = buildAgentCriteria(
      agents,
      master.workspace_id,
    );
    expect(Object.keys(criteria).every((k) => /^a\d+$/.test(k))).toBe(true);
    let total = 0;
    for (const [key, value] of Object.entries(criteria)) {
      expect(estimateDecisionTokens(value)).toBeLessThanOrEqual(DECISION_OPTION_TOKEN_LIMIT);
      total += estimateDecisionTokens(key) + estimateDecisionTokens(value);
    }
    expect(total).toBeLessThanOrEqual(DECISION_OPTIONS_TOTAL_LIMIT);
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

  it('sticky-switches conversation when the decision model is confident', async () => {
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

    safeDecisionChoiceMock.mockResolvedValue({
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

  it('includes recent conversation history in decision state', async () => {
    const user = createUser({
      email: 'hist@test.com',
      password: 'password123',
      display_name: 'Hist',
    });
    const master = getMasterWorkspaceForUser(user.id)!;
    createAgentRecord({
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

    enqueueInboundMessage(
      {
        id: 'in-prev',
        channel_type: 'http',
        platform_id: conv.platform_id,
        thread_id: null,
        kind: 'chat',
        content: { text: 'Earlier billing question' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );
    insertOutboundMessage({
      id: 'out-prev',
      channel_type: 'http',
      platform_id: conv.platform_id,
      thread_id: null,
      conversation_id: conv.id,
      kind: 'chat',
      content: { text: 'Sure, I can help with that invoice.' },
      worker_job_id: 'job-prev',
      agent_name: 'Billing',
      agent_workspace_id: 'ws-billing-hist',
    });

    const inbound = enqueueInboundMessage(
      {
        id: 'in-curr',
        channel_type: 'http',
        platform_id: conv.platform_id,
        thread_id: null,
        kind: 'chat',
        content: { text: 'And the refund status?' },
        timestamp: new Date().toISOString(),
      },
      conv.id,
    );

    safeDecisionChoiceMock.mockResolvedValue({
      type: 'choice',
      choice: 'a0',
      probabilities: { a0: 0.9 },
      confidence: 0.9,
    });

    await applyAutoAgentRoute({ conversation: conv, inbound });
    expect(safeDecisionChoiceMock).toHaveBeenCalled();
    const call = safeDecisionChoiceMock.mock.calls[0]?.[0] as {
      state: { message: string; recent?: string };
    };
    expect(call.state.message).toContain('refund status');
    expect(call.state.recent).toContain('user: Earlier billing question');
    expect(call.state.recent).toMatch(/Billing:? Sure, I can help with that invoice/);
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

    safeDecisionChoiceMock.mockResolvedValue({
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

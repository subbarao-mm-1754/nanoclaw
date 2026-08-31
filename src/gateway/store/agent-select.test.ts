import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from '../store/users.js';
import { createAgentRecord } from '../store/agents.js';
import { findConversation } from '../store/conversations.js';
import { formatAgentsForUser, resolveUserAgent } from './agent-select.js';

beforeEach(() => {
  initGatewayTestDb();
});

afterEach(() => {
  closeGatewayDb();
});

describe('agent-select', () => {
  it('lists and resolves agents by name and id', () => {
    const user = createUser({
      email: 'multi@example.com',
      password: 'password123',
      display_name: 'Multi',
    });

    const a = createAgentRecord({
      name: 'HubSpot Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# a' }],
    });
    const b = createAgentRecord({
      name: 'Support Bot',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# b' }],
    });

    expect(resolveUserAgent(user.id, 'HubSpot Bot').workspace_id).toBe(a.workspace_id);
    expect(resolveUserAgent(user.id, b.workspace_id).workspace_id).toBe(b.workspace_id);
    expect(resolveUserAgent(user.id, 'support').workspace_id).toBe(b.workspace_id);

    const listed = formatAgentsForUser(user, 'zoho-cliq', 'zoho-cliq:chat-1', null);
    expect(listed).toContain('HubSpot Bot');
    expect(listed).toContain('Support Bot');
    expect(listed).toContain('/use');
  });

  it('setConversationWorkspace binds chat to agent', async () => {
    const { setConversationWorkspace } = await import('./conversations.js');
    const user = createUser({
      email: 'bind@example.com',
      password: 'password123',
      display_name: 'Bind',
    });
    const agent = createAgentRecord({
      name: 'CRM',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# crm' }],
    });

    const conv = setConversationWorkspace({
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-9',
      thread_id: null,
      workspace_id: agent.workspace_id,
    });
    expect(conv.workspace_id).toBe(agent.workspace_id);
    expect(findConversation('zoho-cliq', 'zoho-cliq:chat-9', null)?.workspace_id).toBe(
      agent.workspace_id,
    );
  });
});

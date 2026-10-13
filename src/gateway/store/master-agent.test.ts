import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { USER_MASTER_AGENT_NAME } from '../../config.js';
import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from './users.js';
import { ensureUserForChannelSender } from './channel-identities.js';
import { ensureMasterAgentForUser } from './master-agent.js';
import { getDefaultWorkspaceForUser, getMasterWorkspaceForUser } from './workspaces.js';
import { setConversationWorkspace, findConversation } from './conversations.js';
import { createAgentRecord } from './agents.js';

beforeEach(() => {
  initGatewayTestDb();
});

afterEach(() => {
  closeGatewayDb();
});

describe('master agent', () => {
  it('is created once per user and stays the default for new chats', () => {
    const user = createUser({
      email: 'one@example.com',
      password: 'password123',
      display_name: 'One',
    });

    const master = getMasterWorkspaceForUser(user.id)!;
    expect(master.name).toBe(USER_MASTER_AGENT_NAME);
    expect(ensureMasterAgentForUser(user.id).workspace_id).toBe(master.workspace_id);
    expect(getDefaultWorkspaceForUser(user.id)?.workspace_id).toBe(master.workspace_id);

    const specialist = createAgentRecord({
      name: 'Specialist',
      owner_user_id: user.id,
      files: [{ path: 'CLAUDE.local.md', content: '# specialist' }],
    });

    setConversationWorkspace({
      channel_type: 'zoho-cliq',
      platform_id: 'zoho-cliq:chat-use',
      thread_id: null,
      workspace_id: specialist.workspace_id,
    });
    expect(findConversation('zoho-cliq', 'zoho-cliq:chat-use', null)?.workspace_id).toBe(
      specialist.workspace_id,
    );
    // User default for unbound/new chats remains the master agent.
    expect(getDefaultWorkspaceForUser(user.id)?.workspace_id).toBe(master.workspace_id);
  });

  it('is created for channel-auto users', () => {
    const user = ensureUserForChannelSender({
      channel_type: 'zoho-cliq',
      sender_id: 'zuid-123',
      display_name: 'Cliq User',
    });
    const master = getMasterWorkspaceForUser(user.id);
    expect(master).not.toBeNull();
    expect(master!.is_master).toBe(true);
  });

  it('does not mark specialist agents as master or steal their create path', () => {
    const user = createUser({
      email: 'special@example.com',
      password: 'password123',
      display_name: 'Special',
    });
    const master = getMasterWorkspaceForUser(user.id)!;
    const specialist = createAgentRecord({
      name: 'Research Bot',
      owner_user_id: user.id,
      is_default: true, // ignored while master owns default
      files: [{ path: 'CLAUDE.local.md', content: '# research' }],
    });

    expect(specialist.is_master).toBe(false);
    expect(specialist.is_default).toBe(false);
    expect(master.is_default).toBe(true);
    expect(getMasterWorkspaceForUser(user.id)?.workspace_id).toBe(master.workspace_id);
  });
});

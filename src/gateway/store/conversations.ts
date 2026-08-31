import { getGatewayDb } from '../db/connection.js';
import type { Conversation } from '../types.js';
import { getDefaultWorkspace, getWorkspace } from './workspaces.js';

function now(): string {
  return new Date().toISOString();
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    channel_type: row.channel_type as string,
    platform_id: row.platform_id as string,
    thread_id: (row.thread_id as string | null) ?? null,
    workspace_id: row.workspace_id as string,
    session_id: row.session_id as string,
    agent_group_id: row.agent_group_id as string,
    display_name: (row.display_name as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function conversationKey(
  channelType: string,
  platformId: string,
  threadId: string | null,
): string {
  const thread = threadId ?? '';
  return `${channelType}:${platformId}:${thread}`;
}

export function conversationId(
  channelType: string,
  platformId: string,
  threadId: string | null,
): string {
  return `conv-${conversationKey(channelType, platformId, threadId).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export function findConversation(
  channelType: string,
  platformId: string,
  threadId: string | null,
): Conversation | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT * FROM conversations
       WHERE channel_type = ? AND platform_id = ?
         AND COALESCE(thread_id, '') = COALESCE(?, '')`,
    )
    .get(channelType, platformId, threadId) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

export function getOrCreateConversation(input: {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  display_name?: string;
  workspace_id?: string;
}): Conversation {
  const existing = findConversation(input.channel_type, input.platform_id, input.thread_id);
  if (existing) {
    if (input.display_name && input.display_name !== existing.display_name) {
      updateConversationDisplayName(existing.id, input.display_name);
      return { ...existing, display_name: input.display_name, updated_at: now() };
    }
    return existing;
  }

  const workspace = input.workspace_id ? getWorkspace(input.workspace_id) : getDefaultWorkspace();
  if (!workspace) {
    throw new Error(
      'No gateway workspace configured. Register a workspace via POST /v1/workspaces/register or set GATEWAY_DEFAULT_WORKSPACE_ID.',
    );
  }

  const id = conversationId(input.channel_type, input.platform_id, input.thread_id);
  const sessionId = `sess-${id}`;
  const ts = now();

  getGatewayDb()
    .prepare(
      `INSERT INTO conversations
        (id, channel_type, platform_id, thread_id, workspace_id, session_id, agent_group_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.channel_type,
      input.platform_id,
      input.thread_id,
      workspace.workspace_id,
      sessionId,
      workspace.agent_group_id,
      input.display_name ?? null,
      ts,
      ts,
    );

  return findConversation(input.channel_type, input.platform_id, input.thread_id)!;
}

function updateConversationDisplayName(id: string, displayName: string): void {
  getGatewayDb()
    .prepare('UPDATE conversations SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(displayName, now(), id);
}

export function getConversation(id: string): Conversation | null {
  const row = getGatewayDb()
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

/**
 * Bind (or create) this channel chat to a specific agent workspace.
 * Uses a fresh session id so context from a previous agent does not carry over.
 */
export function setConversationWorkspace(input: {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  workspace_id: string;
  display_name?: string;
}): Conversation {
  const workspace = getWorkspace(input.workspace_id);
  if (!workspace) {
    throw new Error(`Workspace not found: ${input.workspace_id}`);
  }

  const existing = findConversation(input.channel_type, input.platform_id, input.thread_id);
  const ts = now();

  if (existing) {
    const sessionId = `sess-${existing.id}-${workspace.workspace_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
    getGatewayDb()
      .prepare(
        `UPDATE conversations SET
           workspace_id = ?,
           agent_group_id = ?,
           session_id = ?,
           display_name = COALESCE(?, display_name),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        workspace.workspace_id,
        workspace.agent_group_id,
        sessionId,
        input.display_name ?? null,
        ts,
        existing.id,
      );
    return getConversation(existing.id)!;
  }

  return getOrCreateConversation({
    channel_type: input.channel_type,
    platform_id: input.platform_id,
    thread_id: input.thread_id,
    workspace_id: workspace.workspace_id,
    display_name: input.display_name,
  });
}

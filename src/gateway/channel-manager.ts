import type { ChannelAdapter } from '../channels/adapter.js';
import {
  getActiveAdapters,
  initChannelAdapters,
  teardownChannelAdapters,
} from '../channels/channel-registry.js';
import { GATEWAY_SKIP_CHANNELS } from '../config.js';
import { log } from '../log.js';
import { routeChannelInbound, type ChannelRouteResult } from './channel-router.js';
import { upsertChannelConnection } from './store/channels.js';
import { ensureUserForChannelSender } from './store/channel-identities.js';
import { enqueueInboundMessage } from './store/messages.js';
import { findConversation, getOrCreateConversation } from './store/conversations.js';
import { ensureMasterAgentForUser } from './store/master-agent.js';
import { getUserById } from './store/users.js';

function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractSenderId(content: unknown, platformId: string): string {
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.senderId === 'string' && obj.senderId.trim()) return obj.senderId.trim();
  }
  return platformId;
}

function extractSenderName(content: unknown, fallback?: string): string | undefined {
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.sender === 'string' && obj.sender.trim()) return obj.sender.trim();
  }
  return fallback;
}

function resolveWorkspaceForNewConversation(
  channelType: string,
  platformId: string,
  threadId: string | null,
  content: unknown,
  senderDisplayName?: string,
): string | undefined {
  if (findConversation(channelType, platformId, threadId)) return undefined;
  try {
    let userId: string | undefined;
    if (content && typeof content === 'object') {
      const gatewayUserId = (content as Record<string, unknown>).gatewayUserId;
      if (typeof gatewayUserId === 'string' && gatewayUserId.trim()) {
        const owner = getUserById(gatewayUserId.trim());
        if (owner) userId = owner.id;
      }
    }
    if (!userId) {
      const senderId = extractSenderId(content, platformId);
      const user = ensureUserForChannelSender({
        channel_type: channelType,
        sender_id: senderId,
        display_name: extractSenderName(content, senderDisplayName),
      });
      userId = user.id;
    }
    // New conversations bind to the user's master agent; `/use` sticks on the conversation.
    return ensureMasterAgentForUser(userId).workspace_id;
  } catch {
    return undefined;
  }
}

export type ChannelIngestResult =
  | { kind: 'builder'; routed: Extract<ChannelRouteResult, { kind: 'builder' }> }
  | { kind: 'agent'; conversationId: string; workspaceId: string; messageId: string };

/**
 * Same slash-command routing + conversation bind as Cliq (and every other channel).
 */
export async function ingestChannelInbound(input: {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: string;
    content: unknown;
    timestamp: string;
  };
  senderDisplayName?: string;
}): Promise<ChannelIngestResult> {
  const routed = await routeChannelInbound({
    channel_type: input.channelType,
    platform_id: input.platformId,
    thread_id: input.threadId,
    content: input.message.content,
    sender_display_name: input.senderDisplayName,
  });

  if (routed.kind === 'builder') {
    log.info('Gateway routed inbound to builder', {
      messageId: input.message.id,
      channelType: input.channelType,
      platformId: input.platformId,
      action: routed.action,
      jobId: routed.jobId,
    });
    return { kind: 'builder', routed };
  }

  const content = routed.content ?? input.message.content;
  const workspaceId = resolveWorkspaceForNewConversation(
    input.channelType,
    input.platformId,
    input.threadId,
    content,
    input.senderDisplayName,
  );

  const conversation = getOrCreateConversation({
    channel_type: input.channelType,
    platform_id: input.platformId,
    thread_id: input.threadId,
    display_name: input.senderDisplayName,
    workspace_id: workspaceId,
  });

  const messageId = input.message.id || newMessageId();
  enqueueInboundMessage(
    {
      id: messageId,
      channel_type: input.channelType,
      platform_id: input.platformId,
      thread_id: input.threadId,
      kind: input.message.kind,
      content,
      timestamp: input.message.timestamp,
      sender_id: extractSenderId(content, input.platformId),
      sender_display_name: input.senderDisplayName,
    },
    conversation.id,
  );

  log.info('Gateway enqueued inbound message', {
    messageId,
    channelType: input.channelType,
    platformId: input.platformId,
    conversationId: conversation.id,
    workspaceId: conversation.workspace_id,
  });

  return {
    kind: 'agent',
    conversationId: conversation.id,
    workspaceId: conversation.workspace_id,
    messageId,
  };
}

async function handleInbound(
  adapter: ChannelAdapter,
  platformId: string,
  threadId: string | null,
  message: {
    id: string;
    kind: string;
    content: unknown;
    timestamp: string;
    isGroup?: boolean;
  },
  senderDisplayName?: string,
): Promise<void> {
  await ingestChannelInbound({
    channelType: adapter.channelType,
    platformId,
    threadId,
    message,
    senderDisplayName,
  });
}

export async function startGatewayChannels(): Promise<void> {
  await initChannelAdapters((adapter: ChannelAdapter) => ({
    onInbound(platformId, threadId, message) {
      void handleInbound(adapter, platformId, threadId, message).catch((err) => {
        log.error('Failed to enqueue inbound message', {
          channelType: adapter.channelType,
          platformId,
          err,
        });
        upsertChannelConnection(adapter.channelType, 'error', adapter.name, String(err));
      });
    },
    onInboundEvent(event) {
      const content = JSON.parse(event.message.content) as unknown;
      void handleInbound(
        { ...adapter, channelType: event.channelType } as ChannelAdapter,
        event.platformId,
        event.threadId,
        {
          id: event.message.id,
          kind: event.message.kind,
          content,
          timestamp: event.message.timestamp,
          isGroup: event.message.isGroup,
        },
      ).catch((err) => {
        log.error('Failed to enqueue inbound event', { channelType: event.channelType, err });
      });
    },
    onMetadata(platformId, name) {
      try {
        getOrCreateConversation({
          channel_type: adapter.channelType,
          platform_id: platformId,
          thread_id: null,
          display_name: name,
        });
      } catch {
        // Workspace may not be registered yet — conversation created on first message.
      }
    },
    onAction() {
      // Gateway does not handle interactive card actions in v1.
    },
  }), { skip: GATEWAY_SKIP_CHANNELS });

  for (const adapter of getActiveAdapters()) {
    upsertChannelConnection(adapter.channelType, 'connected', adapter.name);
  }
}

export async function stopGatewayChannels(): Promise<void> {
  for (const adapter of getActiveAdapters()) {
    upsertChannelConnection(adapter.channelType, 'disconnected', adapter.name);
  }
  await teardownChannelAdapters();
}

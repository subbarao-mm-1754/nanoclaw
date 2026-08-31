import type { ChannelAdapter } from '../channels/adapter.js';
import {
  getActiveAdapters,
  initChannelAdapters,
  teardownChannelAdapters,
} from '../channels/channel-registry.js';
import { GATEWAY_SKIP_CHANNELS } from '../config.js';
import { log } from '../log.js';
import { routeChannelInbound } from './channel-router.js';
import { listUserAgents } from './store/agent-select.js';
import { upsertChannelConnection } from './store/channels.js';
import { ensureUserForChannelSender } from './store/channel-identities.js';
import { enqueueInboundMessage } from './store/messages.js';
import { findConversation, getOrCreateConversation } from './store/conversations.js';

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
    const senderId = extractSenderId(content, platformId);
    const user = ensureUserForChannelSender({
      channel_type: channelType,
      sender_id: senderId,
      display_name: extractSenderName(content, senderDisplayName),
    });
    const agents = listUserAgents(user.id);
    return agents[0]?.workspace_id;
  } catch {
    return undefined;
  }
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
  const routed = await routeChannelInbound({
    channel_type: adapter.channelType,
    platform_id: platformId,
    thread_id: threadId,
    content: message.content,
    sender_display_name: senderDisplayName,
  });

  if (routed.kind === 'builder') {
    log.info('Gateway routed inbound to builder', {
      messageId: message.id,
      channelType: adapter.channelType,
      platformId,
      action: routed.action,
      jobId: routed.jobId,
    });
    return;
  }

  const content = routed.content ?? message.content;
  const workspaceId = resolveWorkspaceForNewConversation(
    adapter.channelType,
    platformId,
    threadId,
    content,
    senderDisplayName,
  );

  const conversation = getOrCreateConversation({
    channel_type: adapter.channelType,
    platform_id: platformId,
    thread_id: threadId,
    display_name: senderDisplayName,
    workspace_id: workspaceId,
  });

  const messageId = message.id || newMessageId();
  enqueueInboundMessage(
    {
      id: messageId,
      channel_type: adapter.channelType,
      platform_id: platformId,
      thread_id: threadId,
      kind: message.kind,
      content,
      timestamp: message.timestamp,
      sender_id: extractSenderId(content, platformId),
      sender_display_name: senderDisplayName,
    },
    conversation.id,
  );

  log.info('Gateway enqueued inbound message', {
    messageId,
    channelType: adapter.channelType,
    platformId,
    conversationId: conversation.id,
    workspaceId: conversation.workspace_id,
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

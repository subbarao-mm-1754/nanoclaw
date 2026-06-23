import type { ChannelAdapter } from '../channels/adapter.js';
import {
  getActiveAdapters,
  initChannelAdapters,
  teardownChannelAdapters,
} from '../channels/channel-registry.js';
import { GATEWAY_SKIP_CHANNELS } from '../config.js';
import { log } from '../log.js';
import { upsertChannelConnection } from './store/channels.js';
import { enqueueInboundMessage } from './store/messages.js';
import { getOrCreateConversation } from './store/conversations.js';

function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const conversation = getOrCreateConversation({
    channel_type: adapter.channelType,
    platform_id: platformId,
    thread_id: threadId,
    display_name: senderDisplayName,
  });

  const messageId = message.id || newMessageId();
  enqueueInboundMessage(
    {
      id: messageId,
      channel_type: adapter.channelType,
      platform_id: platformId,
      thread_id: threadId,
      kind: message.kind,
      content: message.content,
      timestamp: message.timestamp,
      sender_id: platformId,
      sender_display_name: senderDisplayName,
    },
    conversation.id,
  );

  log.info('Gateway enqueued inbound message', {
    messageId,
    channelType: adapter.channelType,
    platformId,
    conversationId: conversation.id,
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

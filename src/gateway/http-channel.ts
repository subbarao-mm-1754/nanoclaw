/**
 * HTTP channel adapter — gateway-only testing transport.
 *
 * Inbound via POST /v1/messages/inbound; outbound stored in http_responses
 * and retrieved via GET /v1/messages/:inboundId/response.
 */
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../channels/adapter.js';
import { registerChannelAdapter } from '../channels/channel-registry.js';
import { saveHttpResponse, type HttpOutboundRecord } from './store/http-responses.js';

let deliveryInboundId: string | null = null;
let deliveryConversationId: string | null = null;
let deliveryWorkerJobId: string | null = null;
const pendingOutbound: HttpOutboundRecord[] = [];

/** Set by the gateway processor before delivering HTTP outbound messages. */
export function beginHttpDelivery(ctx: {
  inboundId: string;
  conversationId: string;
  workerJobId: string;
}): void {
  deliveryInboundId = ctx.inboundId;
  deliveryConversationId = ctx.conversationId;
  deliveryWorkerJobId = ctx.workerJobId;
  pendingOutbound.length = 0;
}

export function endHttpDelivery(): void {
  if (deliveryInboundId && pendingOutbound.length > 0) {
    const first = pendingOutbound[0]!;
    saveHttpResponse({
      inbound_id: deliveryInboundId,
      platform_id: first.platform_id ?? 'unknown',
      thread_id: first.thread_id ?? null,
      conversation_id: deliveryConversationId ?? undefined,
      worker_job_id: deliveryWorkerJobId ?? undefined,
      outbound: [...pendingOutbound],
    });
  }
  deliveryInboundId = null;
  deliveryConversationId = null;
  deliveryWorkerJobId = null;
  pendingOutbound.length = 0;
}

function createHttpAdapter(): ChannelAdapter {
  return {
    name: 'http',
    channelType: 'http',
    supportsThreads: false,

    async setup(_config: ChannelSetup): Promise<void> {
      // Inbound is injected via POST /v1/messages/inbound.
    },

    async teardown(): Promise<void> {},

    isConnected(): boolean {
      return true;
    },

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      if (!deliveryInboundId) {
        throw new Error('HTTP delivery context not set');
      }

      const id = `http-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record: HttpOutboundRecord = {
        id,
        kind: message.kind,
        channel_type: 'http',
        platform_id: platformId,
        thread_id: threadId,
        content:
          typeof message.content === 'object' && message.content !== null
            ? (message.content as Record<string, unknown>)
            : { text: String(message.content) },
        files: message.files?.map((f) => ({
          filename: f.filename,
          data_base64: f.data.toString('base64'),
        })),
      };
      pendingOutbound.push(record);
      return id;
    },
  };
}

registerChannelAdapter('http', {
  factory: () => createHttpAdapter(),
});

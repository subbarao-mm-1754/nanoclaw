import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';
import {
  BuildError,
  cancelBuild,
  continueBuild,
  startBuild,
} from './builder/service.js';
import { getActiveBuildJobForUser } from './store/builds.js';
import { ensureUserForChannelSender } from './store/channel-identities.js';
import type { GatewayUser } from './types.js';

export const BUILD_HELP_TEXT = [
  'Same Cliq chat is used for building agents and talking to them.',
  '',
  'Commands:',
  '• `/build <what you want>` — start the Agent Builder',
  '• While a build is waiting for you — just reply normally (no command)',
  '• `/cancel` — cancel the active build',
  '• `/help` — show this help',
  '',
  'Anything else (when no build is active) goes to your user agent.',
].join('\n');

export type ChannelRouteResult =
  | { kind: 'builder'; action: 'started' | 'continued' | 'cancelled' | 'busy' | 'help'; jobId?: string }
  | { kind: 'agent' };

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

function extractSender(
  content: unknown,
  fallbackPlatformId: string,
  fallbackDisplayName?: string,
): { senderId: string; displayName?: string } {
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.senderId === 'string' && obj.senderId.trim()) {
      return {
        senderId: obj.senderId.trim(),
        displayName:
          typeof obj.sender === 'string' && obj.sender.trim()
            ? obj.sender.trim()
            : fallbackDisplayName,
      };
    }
  }
  return { senderId: fallbackPlatformId, displayName: fallbackDisplayName };
}

async function replyToChannel(
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
): Promise<void> {
  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    log.warn('No adapter for channel reply', { channelType });
    return;
  }
  await adapter.deliver(platformId, threadId, {
    kind: 'chat',
    content: { text },
  });
}

/**
 * Decide whether a channel message belongs to the builder or the user agent.
 *
 * Differentiation (same Cliq chat):
 * - `/build …` starts builder
 * - active build in waiting_for_user → continue builder
 * - `/cancel` cancels builder
 * - otherwise → user agent path
 */
export async function routeChannelInbound(input: {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  content: unknown;
  sender_display_name?: string;
}): Promise<ChannelRouteResult> {
  const text = extractText(input.content).trim();
  const { senderId, displayName } = extractSender(
    input.content,
    input.platform_id,
    input.sender_display_name,
  );

  const user: GatewayUser = ensureUserForChannelSender({
    channel_type: input.channel_type,
    sender_id: senderId,
    display_name: displayName,
  });

  const delivery = {
    channel_type: input.channel_type,
    platform_id: input.platform_id,
    thread_id: input.thread_id,
  };

  const lower = text.toLowerCase();

  if (lower === '/help' || lower === 'help') {
    await replyToChannel(input.channel_type, input.platform_id, input.thread_id, BUILD_HELP_TEXT);
    return { kind: 'builder', action: 'help' };
  }

  if (lower === '/cancel' || lower.startsWith('/cancel ')) {
    try {
      const job = await cancelBuild(user);
      return { kind: 'builder', action: 'cancelled', jobId: job.id };
    } catch (err) {
      const message = err instanceof BuildError ? err.message : 'No active build to cancel.';
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'cancelled' };
    }
  }

  const buildMatch = text.match(/^\/build(?:\s+|:)([\s\S]+)$/i);
  if (buildMatch) {
    const description = buildMatch[1]!.trim();
    if (!description) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'Usage: `/build <description of the agent you want>`',
      );
      return { kind: 'builder', action: 'help' };
    }

    const active = getActiveBuildJobForUser(user.id);
    if (active) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        `You already have an active build (${active.status}). Reply to continue, or \`/cancel\` first.`,
      );
      return { kind: 'builder', action: 'busy', jobId: active.id };
    }

    const job = await startBuild(user, { message: description, delivery });
    await replyToChannel(
      input.channel_type,
      input.platform_id,
      input.thread_id,
      'Starting agent build… I’ll ask questions here as needed. Use `/cancel` to stop.',
    );
    return { kind: 'builder', action: 'started', jobId: job.id };
  }

  const active = getActiveBuildJobForUser(user.id);
  if (active) {
    if (active.status === 'in_progress') {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'Still working on your previous reply — hang tight.',
      );
      return { kind: 'builder', action: 'busy', jobId: active.id };
    }

    if (active.status === 'waiting_for_user') {
      if (!text) {
        await replyToChannel(
          input.channel_type,
          input.platform_id,
          input.thread_id,
          'Send a text reply to continue the build (or `/cancel`).',
        );
        return { kind: 'builder', action: 'help', jobId: active.id };
      }
      await continueBuild(user, active.id, { message: text });
      return { kind: 'builder', action: 'continued', jobId: active.id };
    }
  }

  return { kind: 'agent' };
}

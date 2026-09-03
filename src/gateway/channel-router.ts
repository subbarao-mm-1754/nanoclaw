import { getChannelAdapter } from '../channels/channel-registry.js';
import { log } from '../log.js';
import { deleteAgent } from './agent-service.js';
import {
  BuildError,
  cancelBuild,
  continueBuild,
  isEditJob,
  looksLikeRegisterIntent,
  registerBuildFromStoredMessages,
  runPreviewTest,
  saveEdit,
  startBuild,
  startEdit,
} from './builder/service.js';
import {
  IntegrationError,
  startOAuthConnect,
} from './integrations/broker.js';
import {
  extractPrimaryRemoteMcpUrl,
  suggestMcpServerName,
} from './integrations/mcp-url.js';
import {
  AgentResolveError,
  formatAgentsForUser,
  listUserAgents,
  resolveUserAgent,
} from './store/agent-select.js';
import { AgentDeleteError, getAgentForUser } from './store/agents.js';
import { getActiveBuildJobForUser } from './store/builds.js';
import { ensureUserForChannelSender } from './store/channel-identities.js';
import { findConversation, setConversationWorkspace } from './store/conversations.js';
import type { GatewayAgent, GatewayUser } from './types.js';
import { getUserById } from './store/users.js';

export const BUILD_HELP_TEXT = [
  'Same Cliq chat is used for building agents, editing them, and talking to them.',
  '',
  'Commands:',
  '• `/build <what you want>` — start the Agent Builder (creates a new agent)',
  '• `/edit <name or id>` — edit an existing agent without switching this chat’s agent',
  '• `/edit` — edit the agent currently bound to this chat',
  '• `/test <message>` — while editing, send that message to the draft (edits so far). Does not switch this chat’s agent',
  '• `/save` — apply the current draft to the live agent (chat binding unchanged)',
  '• While a build/edit is waiting for you — just reply normally (no command)',
  '• Paste a Zoho-managed MCP URL (or `/mcp <url>`) during a build/edit — Gateway sends an authorize link',
  '• `/cancel` — cancel the active build or edit',
  '• `/chat` — cancel any active build/edit and switch to user-agent mode',
  '• `/agents` — list your user agents (marks which is active in this chat)',
  '• `/use <name or id>` — bind this chat to a user agent',
  '• `/delete <name or id>` — permanently delete a user agent',
  '• `/register` or reply **Register it now** — after a finished `/build`, create the agent and clean up the builder',
  '• `/help` — show this help',
  '',
  'Anything else (when no build/edit is active) goes to the agent bound to this chat.',
].join('\n');

export type ChannelRouteResult =
  | {
      kind: 'builder';
      action:
        | 'started'
        | 'continued'
        | 'cancelled'
        | 'busy'
        | 'help'
        | 'agents'
        | 'use'
        | 'delete'
        | 'register'
        | 'edit'
        | 'test'
        | 'save';
      jobId?: string;
    }
  | { kind: 'agent'; content?: unknown };

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

function resolveEditTarget(
  user: GatewayUser,
  query: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): { agent: GatewayAgent; instruction: string } {
  const conv = findConversation(channelType, platformId, threadId);
  const current =
    conv && listUserAgents(user.id).find((a) => a.workspace_id === conv.workspace_id);

  const asAgent = (workspaceId: string): GatewayAgent => {
    const agent = getAgentForUser(workspaceId, user.id);
    if (!agent) throw new AgentResolveError('Agent not found', 404);
    return agent;
  };

  if (!query) {
    if (!current) {
      throw new AgentResolveError(
        'Usage: `/edit <agent name or id>` (or bind an agent with `/use` and then `/edit`).',
      );
    }
    return { agent: asAgent(current.workspace_id), instruction: '' };
  }

  try {
    const resolved = resolveUserAgent(user.id, query);
    return { agent: asAgent(resolved.workspace_id), instruction: '' };
  } catch (err) {
    const split = query.match(/^(.+?)\s*[:|]\s*([\s\S]+)$/);
    if (split) {
      const resolved = resolveUserAgent(user.id, split[1]!.trim());
      return { agent: asAgent(resolved.workspace_id), instruction: split[2]!.trim() };
    }
    if (current) {
      return { agent: asAgent(current.workspace_id), instruction: query };
    }
    throw err;
  }
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
 * If the message contains a remote MCP URL, start OAuth and tell the user to
 * open the authorize link. Returns true when a URL was found (OAuth attempted).
 */
async function maybeStartBuildMcpOAuth(input: {
  user: GatewayUser;
  buildJobId: string;
  text: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
}): Promise<boolean> {
  const mcpUrl = extractPrimaryRemoteMcpUrl(input.text);
  if (!mcpUrl) return false;

  try {
    const result = await startOAuthConnect({
      userId: input.user.id,
      mcpUrl,
      mcpServerName: suggestMcpServerName(mcpUrl),
      buildJobId: input.buildJobId,
    });
    if (result.reused) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        [
          'Remote MCP detected — already authorized for your account.',
          '',
          `Using existing connection (\`${result.provider}\`).`,
          'It will attach automatically when the agent is registered. No need to authorize again.',
        ].join('\n'),
      );
    } else {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        [
          'Remote MCP detected. Complete authorization in your browser, then continue this chat.',
          '',
          `Open this link: ${result.authorize_url}`,
          '',
          'After you authorize, this MCP will attach automatically when the agent is created.',
        ].join('\n'),
      );
    }
  } catch (err) {
    const message =
      err instanceof IntegrationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn('Build MCP OAuth start failed', { buildJobId: input.buildJobId, err });
    await replyToChannel(
      input.channel_type,
      input.platform_id,
      input.thread_id,
      `Could not start MCP authorization for that URL: ${message}`,
    );
  }
  return true;
}

/**
 * Decide whether a channel message belongs to the builder or the user agent.
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

  // Multi-account channels (e.g. Zoho Cliq) tag inbound with the Gateway user
  // who owns the OAuth connection — prefer that over auto-created sender users.
  let user: GatewayUser | null = null;
  if (input.content && typeof input.content === 'object') {
    const gatewayUserId = (input.content as Record<string, unknown>).gatewayUserId;
    if (typeof gatewayUserId === 'string' && gatewayUserId.trim()) {
      user = getUserById(gatewayUserId.trim());
    }
  }
  if (!user) {
    user = ensureUserForChannelSender({
      channel_type: input.channel_type,
      sender_id: senderId,
      display_name: displayName,
    });
  }

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

  if (lower === '/agents' || lower === '/agent' || lower === '/list') {
    await replyToChannel(
      input.channel_type,
      input.platform_id,
      input.thread_id,
      formatAgentsForUser(user, input.channel_type, input.platform_id, input.thread_id),
    );
    return { kind: 'builder', action: 'agents' };
  }

  if (lower === '/register' || looksLikeRegisterIntent(text)) {
    try {
      const job = await registerBuildFromStoredMessages(user);
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        job.status === 'completed'
          ? isEditJob(job)
            ? `Saved. This chat is still using the same agent as before. Try \`/agents\` if you want to switch.`
            : `Registered. This chat should now use "${job.title ?? 'your agent'}". Try \`/agents\`.`
          : `Build status is now ${job.status}.`,
      );
      return { kind: 'builder', action: 'register', jobId: job.id };
    } catch (err) {
      const message = err instanceof BuildError ? err.message : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      // Nudge path still counts as register intent handled.
      return { kind: 'builder', action: 'register' };
    }
  }

  const useMatch = text.match(/^\/use(?:\s+|:)([\s\S]+)$/i);
  if (lower === '/use' || useMatch) {
    const query = useMatch?.[1]?.trim() ?? '';
    if (!query) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'Usage: `/use <agent name or workspace id>`\n\n' +
          formatAgentsForUser(user, input.channel_type, input.platform_id, input.thread_id),
      );
      return { kind: 'builder', action: 'help' };
    }

    try {
      const agent = resolveUserAgent(user.id, query);
      setConversationWorkspace({
        channel_type: input.channel_type,
        platform_id: input.platform_id,
        thread_id: input.thread_id,
        workspace_id: agent.workspace_id,
        display_name: displayName,
      });
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        `This chat is now using agent "${agent.name}" (\`${agent.workspace_id}\`). Send a normal message to talk to it.`,
      );
      return { kind: 'builder', action: 'use' };
    } catch (err) {
      const message = err instanceof AgentResolveError ? err.message : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'help' };
    }
  }

  const deleteMatch = text.match(/^\/delete(?:\s+|:)([\s\S]+)$/i);
  if (lower === '/delete' || deleteMatch) {
    const query = deleteMatch?.[1]?.trim() ?? '';
    if (!query) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'Usage: `/delete <agent name or workspace id>` (permanent).\n\n' +
          formatAgentsForUser(user, input.channel_type, input.platform_id, input.thread_id),
      );
      return { kind: 'builder', action: 'help' };
    }

    try {
      const agent = resolveUserAgent(user.id, query);
      const result = await deleteAgent(agent.workspace_id, user.id);
      const lines = [
        `Deleted agent "${result.agent.name}" (\`${result.agent.workspace_id}\`).`,
      ];
      if (result.rebound_agent_name && result.rebound_workspace_id) {
        lines.push(
          `Chats that were using it now use "${result.rebound_agent_name}" (\`${result.rebound_workspace_id}\`).`,
        );
      } else if (result.conversations_cleared > 0) {
        lines.push('No other agents left — those chats need `/use <name>` or `/build …` before chatting again.');
      }
      lines.push('List remaining agents with `/agents`.');
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, lines.join('\n'));
      return { kind: 'builder', action: 'delete' };
    } catch (err) {
      const message =
        err instanceof AgentResolveError || err instanceof AgentDeleteError
          ? err.message
          : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'help' };
    }
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

  if (lower === '/chat' || lower.startsWith('/chat ')) {
    const active = getActiveBuildJobForUser(user.id);
    if (active) {
      try {
        await cancelBuild(user);
      } catch {
        /* ignore */
      }
    }
    const rest = text.replace(/^\/chat\s*/i, '').trim();
    if (!rest) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'User-agent mode. Send your next message normally, or `/agents` / `/use <name>` to pick an agent. This chat’s bound agent was not changed.',
      );
      return { kind: 'builder', action: 'cancelled', jobId: active?.id };
    }
    const content =
      typeof input.content === 'object' && input.content
        ? { ...(input.content as Record<string, unknown>), text: rest }
        : { text: rest };
    return { kind: 'agent', content };
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
        `You already have an active ${isEditJob(active) ? 'edit' : 'build'} (${active.status}). Reply to continue, or \`/cancel\` first.`,
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
    await maybeStartBuildMcpOAuth({
      user,
      buildJobId: job.id,
      text: description,
      channel_type: input.channel_type,
      platform_id: input.platform_id,
      thread_id: input.thread_id,
    });
    return { kind: 'builder', action: 'started', jobId: job.id };
  }

  const editMatch = text.match(/^\/edit(?:\s+|:)([\s\S]*)$/i);
  if (lower === '/edit' || editMatch) {
    const query = (editMatch?.[1] ?? '').trim();
    try {
      const { agent, instruction } = resolveEditTarget(
        user,
        query,
        input.channel_type,
        input.platform_id,
        input.thread_id,
      );
      const boundBefore = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      const job = await startEdit(user, {
        agent,
        message: instruction,
        delivery,
      });
      const boundAfter = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      if (boundBefore && boundAfter && boundBefore !== boundAfter) {
        log.warn('Edit start unexpectedly changed chat agent binding', {
          boundBefore,
          boundAfter,
          jobId: job.id,
        });
      }
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        [
          `Editing "${agent.name}" (\`${agent.workspace_id}\`).`,
          'This chat’s bound agent is unchanged — replies here go to the editor, not a switched user agent.',
          '`/test <message>` runs that message on the draft with edits so far.',
          '`/save` applies the draft. `/cancel` discards it.',
        ].join('\n'),
      );
      await maybeStartBuildMcpOAuth({
        user,
        buildJobId: job.id,
        text: instruction || query,
        channel_type: input.channel_type,
        platform_id: input.platform_id,
        thread_id: input.thread_id,
      });
      return { kind: 'builder', action: 'edit', jobId: job.id };
    } catch (err) {
      const message =
        err instanceof AgentResolveError || err instanceof BuildError ? err.message : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'help' };
    }
  }

  const testMatch = text.match(/^\/test(?:\s+|:)([\s\S]*)$/i);
  if (lower === '/test' || testMatch) {
    const activeForTest = getActiveBuildJobForUser(user.id);
    const testMessage = (testMatch?.[1] ?? '').trim();
    if (!activeForTest) {
      await replyToChannel(
        input.channel_type,
        input.platform_id,
        input.thread_id,
        'No active edit. Start one with `/edit <agent>`, then `/test <message>`.',
      );
      return { kind: 'builder', action: 'help' };
    }
    try {
      const boundBefore = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      await runPreviewTest(user, activeForTest.id, { message: testMessage });
      const boundAfter = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      if (boundBefore && boundAfter && boundBefore !== boundAfter) {
        log.warn('Preview test unexpectedly changed chat agent binding', {
          boundBefore,
          boundAfter,
          jobId: activeForTest.id,
        });
      }
      return { kind: 'builder', action: 'test', jobId: activeForTest.id };
    } catch (err) {
      const message = err instanceof BuildError ? err.message : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'help', jobId: activeForTest.id };
    }
  }

  if (lower === '/save' || lower.startsWith('/save ')) {
    try {
      const boundBefore = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      const job = await saveEdit(user);
      const boundAfter = findConversation(
        input.channel_type,
        input.platform_id,
        input.thread_id,
      )?.workspace_id;
      if (boundBefore && boundAfter && boundBefore !== boundAfter) {
        log.warn('Save edit unexpectedly changed chat agent binding', {
          boundBefore,
          boundAfter,
          jobId: job.id,
        });
      }
      return { kind: 'builder', action: 'save', jobId: job.id };
    } catch (err) {
      const message = err instanceof BuildError ? err.message : String(err);
      await replyToChannel(input.channel_type, input.platform_id, input.thread_id, message);
      return { kind: 'builder', action: 'help' };
    }
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
          isEditJob(active)
            ? 'Send a text reply to continue the edit (or `/test <message>`, `/save`, `/cancel`).'
            : 'Send a text reply to continue the build (or `/cancel`).',
        );
        return { kind: 'builder', action: 'help', jobId: active.id };
      }
      await maybeStartBuildMcpOAuth({
        user,
        buildJobId: active.id,
        text,
        channel_type: input.channel_type,
        platform_id: input.platform_id,
        thread_id: input.thread_id,
      });
      // Pure `/mcp <url>` — only start OAuth; don't bounce the builder.
      if (/^\/mcp(?:\s|$)/i.test(text)) {
        return { kind: 'builder', action: 'continued', jobId: active.id };
      }
      await continueBuild(user, active.id, { message: text });
      return { kind: 'builder', action: 'continued', jobId: active.id };
    }
  }

  return { kind: 'agent' };
}

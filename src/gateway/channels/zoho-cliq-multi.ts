/**
 * Multi-account Zoho Cliq adapter for the Gateway.
 *
 * Uses a shared OAuth app (client id/secret in env) and per-user refresh
 * tokens from gateway_oauth_connections. Each connected user is polled
 * independently; inbound messages are attributed so routing uses that
 * user's agents.
 */
import type {
  ChannelAdapter,
  ChannelSetup,
  ConversationInfo,
  InboundMessage,
  OutboundMessage,
} from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import type { OAuthConnection } from '../integrations/types.js';
import {
  cliqApiBase,
  defaultCliqBotUniqueName,
  defaultCliqChannelEndpoint,
  isZohoCliqOAuthAppConfigured,
  ZOHO_CLIQ_PROVIDER_ID,
} from '../integrations/providers/zoho-cliq.js';
import {
  ensureCliqAccessToken,
  listConnectedCliqAccounts,
  onCliqAccountsChanged,
  parseCliqMeta,
  resolveCliqApiBase,
} from './zoho-cliq-accounts.js';

const CHANNEL_TYPE = ZOHO_CLIQ_PROVIDER_ID;
const POLL_INTERVAL_MS = 5_000;
const MAX_MESSAGE_POLLS_PER_CYCLE = 3;
const MAX_DELIVERED_ID_CACHE = 500;

interface ZohoMessage {
  id: string;
  time: number;
  type: string;
  sender: { name: string; id: string };
  content: { text?: string };
  meta?: { message_source?: { type?: string } };
  bot?: { name?: string; id?: string };
}

interface AccountRuntime {
  connectionId: string;
  userId: string;
  chatIds: string[];
  botUniqueName: string;
  channelEndpoint: string;
  apiBase: string;
  botUserId: string;
  cliqUserId: string;
  lastSeenTime: Map<string, number>;
  pollBaselined: Set<string>;
}

function buildRuntime(connection: OAuthConnection, previous?: AccountRuntime): AccountRuntime | null {
  const meta = parseCliqMeta(connection);
  const chatIds = (meta.chat_ids ?? []).map((id) => id.trim()).filter(Boolean);
  const botUniqueName = meta.bot_unique_name?.trim() || defaultCliqBotUniqueName() || '';
  const channelEndpoint = meta.channel_endpoint?.trim() || defaultCliqChannelEndpoint() || '';
  // Channel endpoint DC wins over gateway default (e.g. .in vs .com).
  const apiBase = resolveCliqApiBase({
    ...meta,
    channel_endpoint: channelEndpoint || meta.channel_endpoint,
  });

  if (!botUniqueName || !channelEndpoint) {
    log.warn('Zoho Cliq account missing bot_unique_name or channel_endpoint — skipping poll', {
      connectionId: connection.id,
      userId: connection.user_id,
    });
    return null;
  }

  if (meta.api_base && meta.api_base.replace(/\/$/, '') !== apiBase) {
    log.info('Zoho Cliq api_base derived from channel endpoint', {
      connectionId: connection.id,
      stored: meta.api_base,
      using: apiBase,
    });
  }

  return {
    connectionId: connection.id,
    userId: connection.user_id,
    chatIds,
    botUniqueName,
    channelEndpoint,
    apiBase,
    botUserId: previous?.botUserId ?? '',
    cliqUserId: meta.cliq_user_id ?? previous?.cliqUserId ?? '',
    lastSeenTime: previous?.lastSeenTime ?? new Map(),
    pollBaselined: previous?.pollBaselined ?? new Set(),
  };
}

export function createZohoCliqMultiAdapter(): ChannelAdapter | null {
  // Always register so operator can configure the OAuth app after gateway start
  // without a process restart. Polling stays idle until client id/secret exist
  // and at least one user has connected + chat IDs.
  if (!isZohoCliqOAuthAppConfigured()) {
    log.info(
      'Zoho Cliq multi-account adapter starting without OAuth app — configure via Agent Studio or PUT /v1/channels/zoho-cliq/oauth-app',
    );
  }

  let setupConfig: ChannelSetup;
  let connected = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubReload: (() => void) | null = null;
  const accounts = new Map<string, AccountRuntime>();
  /** chatId → connectionId for outbound token selection */
  const chatOwners = new Map<string, string>();
  const deliveredMessageIds = new Set<string>();

  function reloadAccounts(): void {
    const previous = new Map(accounts);
    accounts.clear();
    chatOwners.clear();

    for (const connection of listConnectedCliqAccounts()) {
      const runtime = buildRuntime(connection, previous.get(connection.id));
      if (!runtime) continue;
      accounts.set(connection.id, runtime);
      for (const chatId of runtime.chatIds) {
        if (!chatOwners.has(chatId)) chatOwners.set(chatId, connection.id);
      }
    }

    log.info('Zoho Cliq multi-account reload', {
      accounts: accounts.size,
      chats: chatOwners.size,
    });
  }

  async function apiFor(
    account: AccountRuntime,
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    const token = await ensureCliqAccessToken(account.connectionId);
    const url = path.startsWith('http') ? path : `${account.apiBase}/api/v2${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 401 && !retried) {
      log.warn('Zoho Cliq API 401 — forcing token refresh and retry', {
        connectionId: account.connectionId,
        apiBase: account.apiBase,
        path,
      });
      await ensureCliqAccessToken(account.connectionId, { forceRefresh: true });
      return apiFor(account, method, path, body, true);
    }
    if (!res.ok) {
      throw new Error(`Zoho Cliq API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Zoho Cliq returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  function isBotOrOwnMessage(account: AccountRuntime, msg: ZohoMessage): boolean {
    if (msg.meta?.message_source?.type === 'bot') return true;
    if (deliveredMessageIds.has(msg.id)) return true;
    const senderId = msg.sender.id;
    if (senderId.startsWith('b-')) return true;
    if (account.botUserId && (senderId === account.botUserId || senderId === `b-${account.botUserId}`)) {
      return true;
    }
    if (msg.bot?.id && senderId === msg.bot.id) return true;
    return false;
  }

  async function resolveBotUserId(account: AccountRuntime): Promise<void> {
    if (account.botUserId) return;
    try {
      const token = await ensureCliqAccessToken(account.connectionId);
      const res = await fetch(
        `${account.apiBase}/api/v3/bots/${encodeURIComponent(account.botUniqueName)}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { id?: string } };
      account.botUserId = body.data?.id ?? '';
    } catch (err) {
      log.warn('Zoho Cliq multi: could not resolve bot user id', {
        connectionId: account.connectionId,
        err,
      });
    }
  }

  async function pollMessages(account: AccountRuntime, chatId: string): Promise<void> {
    const lastTime = account.lastSeenTime.get(chatId) ?? 0;
    const isColdStart = !account.pollBaselined.has(chatId);
    const params = isColdStart ? '?limit=20' : `?fromtime=${lastTime + 1}&limit=20`;

    const res = (await apiFor(
      account,
      'GET',
      `/chats/${chatId}/messages${params}`,
    )) as { data?: ZohoMessage[] };
    const messages = res.data ?? [];

    setupConfig.onMetadata(`${CHANNEL_TYPE}:${chatId}`, chatId, true);

    for (const msg of messages) {
      if (msg.time > (account.lastSeenTime.get(chatId) ?? 0)) {
        account.lastSeenTime.set(chatId, msg.time);
      }
    }

    if (isColdStart) {
      account.pollBaselined.add(chatId);
      log.info('Zoho Cliq multi poll baseline', {
        connectionId: account.connectionId,
        chatId,
        messagesSeen: messages.length,
      });
      return;
    }

    for (const msg of messages) {
      if (msg.time <= lastTime) continue;
      if (isBotOrOwnMessage(account, msg)) continue;
      if (msg.type !== 'text' || !msg.content.text) continue;

      const inbound: InboundMessage = {
        id: msg.id,
        kind: 'chat',
        content: {
          text: msg.content.text,
          sender: msg.sender.name,
          senderId: `${CHANNEL_TYPE}:${msg.sender.id}`,
          // Prefer the Gateway user who owns this Cliq connection for agent routing.
          gatewayUserId: account.userId,
          cliqConnectionId: account.connectionId,
        },
        timestamp: new Date(msg.time).toISOString(),
        isMention: false,
      };

      log.info('Zoho Cliq multi inbound', {
        connectionId: account.connectionId,
        gatewayUserId: account.userId,
        chatId,
        messageId: msg.id,
        textPreview: msg.content.text.slice(0, 80),
      });

      await setupConfig.onInbound(`${CHANNEL_TYPE}:${chatId}`, null, inbound);
    }
  }

  async function pollAccount(account: AccountRuntime): Promise<void> {
    if (account.chatIds.length === 0) return;
    await resolveBotUserId(account);
    let messagePollCount = 0;
    for (const chatId of account.chatIds) {
      if (messagePollCount >= MAX_MESSAGE_POLLS_PER_CYCLE) break;
      try {
        await pollMessages(account, chatId);
        messagePollCount += 1;
      } catch (err) {
        log.warn('Zoho Cliq multi message poll error', {
          connectionId: account.connectionId,
          chatId,
          err,
        });
      }
    }
  }

  async function poll(): Promise<void> {
    const snapshot = [...accounts.values()];
    for (const account of snapshot) {
      try {
        await pollAccount(account);
      } catch (err) {
        log.error('Zoho Cliq multi poll error', {
          connectionId: account.connectionId,
          err,
        });
      }
    }
  }

  function resolveAccountForChat(chatId: string): AccountRuntime | undefined {
    const connectionId = chatOwners.get(chatId);
    if (connectionId) return accounts.get(connectionId);
    // Fallback: any account that lists this chat
    for (const account of accounts.values()) {
      if (account.chatIds.includes(chatId)) return account;
    }
    // Last resort: first connected account (shared bot outbound)
    return accounts.values().next().value;
  }

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      reloadAccounts();
      unsubReload = onCliqAccountsChanged(() => reloadAccounts());
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      void poll();
      connected = true;
      log.info('Zoho Cliq multi-account adapter started', {
        accounts: accounts.size,
        apiBase: cliqApiBase(),
      });
    },

    async teardown(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (unsubReload) {
        unsubReload();
        unsubReload = null;
      }
      connected = false;
      accounts.clear();
      chatOwners.clear();
      log.info('Zoho Cliq multi-account adapter stopped');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      const chatId = platformId.replace(/^zohocliq:/, '').replace(/^zoho-cliq:/, '');
      const account = resolveAccountForChat(chatId);
      if (!account) {
        throw new Error('No Zoho Cliq account connected to deliver this message');
      }

      const content = message.content as Record<string, unknown>;
      const botParam = `bot_unique_name=${encodeURIComponent(account.botUniqueName)}`;

      if (content.operation === 'edit' && content.messageId) {
        await apiFor(account, 'PUT', `/chats/${chatId}/messages/${content.messageId}?${botParam}`, {
          text: (content.text as string) || (content.markdown as string) || '',
        });
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await apiFor(
          account,
          'POST',
          `/chats/${chatId}/messages/${content.messageId}/reactions?${botParam}`,
          { emoji_code: content.emoji as string },
        );
        return;
      }

      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        const token = await ensureCliqAccessToken(account.connectionId);
        const sendUrl = `${account.channelEndpoint}?bot_unique_name=${encodeURIComponent(account.botUniqueName)}`;
        const res = await fetch(sendUrl, {
          method: 'POST',
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Zoho Cliq bot send failed (${res.status}): ${body}`);
        }
        let messageId: string | undefined;
        try {
          const data = (await res.json()) as { message_id?: string };
          messageId = data.message_id;
        } catch {
          /* empty body */
        }
        if (messageId) {
          deliveredMessageIds.add(messageId);
          if (deliveredMessageIds.size > MAX_DELIVERED_ID_CACHE) {
            const oldest = deliveredMessageIds.values().next().value;
            if (oldest) deliveredMessageIds.delete(oldest);
          }
        }
        log.info('Zoho Cliq multi message delivered', {
          connectionId: account.connectionId,
          chatId,
          messageId: messageId ?? null,
        });
        return messageId;
      }

      if (message.files?.length) {
        for (const file of message.files) {
          const formData = new FormData();
          formData.append('file', new Blob([file.data]), file.filename);
          const token = await ensureCliqAccessToken(account.connectionId);
          const res = await fetch(`${account.apiBase}/api/v2/chats/${chatId}/files`, {
            method: 'POST',
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            body: formData,
          });
          if (!res.ok) {
            log.warn('Zoho Cliq multi file upload failed', { chatId, status: res.status });
          }
        }
      }

      return undefined;
    },

    async syncConversations(): Promise<ConversationInfo[]> {
      const out: ConversationInfo[] = [];
      for (const account of accounts.values()) {
        for (const chatId of account.chatIds) {
          out.push({
            platformId: `${CHANNEL_TYPE}:${chatId}`,
            name: chatId,
            isGroup: false,
          });
        }
      }
      return out;
    },
  };

  return adapter;
}

/** Overwrite the env-based zoho-cliq factory (Gateway multi-account mode). */
export function registerZohoCliqMultiAdapter(): void {
  registerChannelAdapter(CHANNEL_TYPE, { factory: createZohoCliqMultiAdapter });
  log.info('Zoho Cliq multi-account adapter registered');
}

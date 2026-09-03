import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cliq-'));
process.env.GATEWAY_DB_PATH = path.join(tmpDir, 'gateway.db');
process.env.ZOHO_CLIQ_CLIENT_ID = 'test-cliq-client';
process.env.ZOHO_CLIQ_CLIENT_SECRET = 'test-cliq-secret';
process.env.ZOHO_CLIQ_API_URL = 'https://cliq.zoho.com';
process.env.ZOHO_CLIQ_BOT_UNIQUE_NAME = 'test-bot';
process.env.ZOHO_CLIQ_CHANNEL_ENDPOINT =
  'https://cliq.zoho.com/api/v2/channelsbyname/test/message';
process.env.GATEWAY_PUBLIC_URL = 'http://127.0.0.1:8090';

const { initGatewayDb, closeGatewayDb } = await import('../db/connection.js');
const { createUser } = await import('../store/users.js');
const { linkChannelIdentity, ensureUserForChannelSender } = await import(
  '../store/channel-identities.js'
);
const {
  applyTokenSet,
  mergeConnectionMetadata,
  upsertPendingConnection,
  listConnectionsByProvider,
} = await import('../integrations/store.js');
const {
  getCliqStatusForUser,
  updateCliqAccountConfig,
  disconnectCliqAccount,
  parseCliqMeta,
  finalizeCliqChannelConnect,
} = await import('./zoho-cliq-accounts.js');
const { isZohoCliqOAuthAppConfigured, zohoCliqProvider } = await import(
  '../integrations/providers/zoho-cliq.js'
);
const { isChannelOAuthProvider } = await import('../integrations/broker.js');

describe('zoho-cliq multi-user channel accounts', () => {
  beforeEach(() => {
    closeGatewayDb();
    if (fs.existsSync(process.env.GATEWAY_DB_PATH!)) {
      fs.unlinkSync(process.env.GATEWAY_DB_PATH!);
    }
    initGatewayDb();
  });

  afterEach(() => {
    closeGatewayDb();
  });

  it('detects OAuth app from env', () => {
    expect(isZohoCliqOAuthAppConfigured()).toBe(true);
    expect(zohoCliqProvider.id).toBe('zoho-cliq');
    expect(isChannelOAuthProvider('zoho-cliq')).toBe(true);
    expect(isChannelOAuthProvider('zoho')).toBe(false);
  });

  it('stores per-user chat_ids in connection metadata', () => {
    const user = createUser({
      email: 'cliq-user@example.com',
      password: 'password123',
      display_name: 'Cliq User',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    applyTokenSet(pending.id, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    });

    const status = updateCliqAccountConfig(user.id, {
      chat_ids: ['chat-a', ' chat-b '],
      bot_unique_name: 'my-bot',
    });
    expect(status.connected).toBe(true);
    expect(status.chat_ids).toEqual(['chat-a', 'chat-b']);
    expect(status.bot_unique_name).toBe('my-bot');

    const listed = listConnectionsByProvider('zoho-cliq');
    expect(listed).toHaveLength(1);
    expect(parseCliqMeta(listed[0]!).chat_ids).toEqual(['chat-a', 'chat-b']);
  });

  it('merges metadata on token refresh without dropping chat_ids', () => {
    const user = createUser({
      email: 'merge@example.com',
      password: 'password123',
      display_name: 'Merge',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    applyTokenSet(pending.id, {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_in: 3600,
      metadata: { chat_ids: ['keep-me'] },
    });
    const refreshed = applyTokenSet(pending.id, {
      access_token: 'a2',
      expires_in: 3600,
      metadata: { api_domain: 'https://accounts.zoho.com' },
    });
    const meta = parseCliqMeta(refreshed);
    expect(meta.chat_ids).toEqual(['keep-me']);
    expect(meta.api_domain).toBe('https://accounts.zoho.com');
  });

  it('links Cliq ZUID to the authenticating gateway user', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });
    linkChannelIdentity({
      user_id: user.id,
      channel_type: 'zoho-cliq',
      sender_id: 'zoho-cliq:zuid-99',
      display_name: 'Owner',
    });
    const resolved = ensureUserForChannelSender({
      channel_type: 'zoho-cliq',
      sender_id: 'zoho-cliq:zuid-99',
    });
    expect(resolved.id).toBe(user.id);
  });

  it('disconnect clears connection and status', () => {
    const user = createUser({
      email: 'bye@example.com',
      password: 'password123',
      display_name: 'Bye',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    applyTokenSet(pending.id, {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
    });
    expect(getCliqStatusForUser(user.id).connected).toBe(true);
    disconnectCliqAccount(user.id);
    expect(getCliqStatusForUser(user.id).connected).toBe(false);
  });

  it('finalizeCliqChannelConnect seeds defaults from env', async () => {
    const user = createUser({
      email: 'fin@example.com',
      password: 'password123',
      display_name: 'Fin',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    const connected = applyTokenSet(pending.id, {
      access_token: 'tok',
      refresh_token: 'ref',
      expires_in: 3600,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: 'zuid-1', name: 'Fin Cliq' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const updated = await finalizeCliqChannelConnect(connected);
      const meta = parseCliqMeta(updated);
      expect(meta.cliq_user_id).toBe('zuid-1');
      expect(meta.bot_unique_name).toBe('test-bot');
      expect(meta.channel_endpoint).toContain('channelsbyname');
      expect(meta.chat_ids).toEqual([]);

      const linked = ensureUserForChannelSender({
        channel_type: 'zoho-cliq',
        sender_id: 'zoho-cliq:zuid-1',
      });
      expect(linked.id).toBe(user.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('finalizeCliqChannelConnect uses per-user Accounts DC from token metadata', async () => {
    const user = createUser({
      email: 'india@example.com',
      password: 'password123',
      display_name: 'India',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    const connected = applyTokenSet(pending.id, {
      access_token: 'tok-in',
      refresh_token: 'ref-in',
      expires_in: 3600,
      metadata: { accounts_base: 'https://accounts.zoho.in' },
    });

    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchedUrls.push(String(input));
      return new Response(JSON.stringify({ data: { id: 'zuid-in', name: 'IN User' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const updated = await finalizeCliqChannelConnect(connected);
      const meta = parseCliqMeta(updated);
      expect(meta.accounts_base).toBe('https://accounts.zoho.in');
      expect(meta.api_base).toBe('https://cliq.zoho.in');
      expect(meta.channel_endpoint).toBe(
        'https://cliq.zoho.in/api/v2/channelsbyname/test/message',
      );
      expect(fetchedUrls[0]).toContain('https://cliq.zoho.in/api/v2/me');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolveCliqAccountsBase prefers connection accounts_base over gateway default', async () => {
    const { resolveCliqAccountsBase, resolveCliqApiBase } = await import('./zoho-cliq-accounts.js');
    expect(
      resolveCliqAccountsBase({ accounts_base: 'https://accounts.zoho.eu' }),
    ).toBe('https://accounts.zoho.eu');
    expect(resolveCliqApiBase({ accounts_base: 'https://accounts.zoho.eu' })).toBe(
      'https://cliq.zoho.eu',
    );
    expect(
      resolveCliqAccountsBase({
        channel_endpoint: 'https://cliq.zoho.in/api/v2/channelsbyname/x/message',
      }),
    ).toBe('https://accounts.zoho.in');
  });

  it('resolves Accounts DC from Zoho OAuth redirect params', async () => {
    const {
      accountsBaseFromLocation,
      resolveAccountsBaseFromOAuthRedirect,
      cliqApiBaseFromAccountsBase,
    } = await import('../integrations/providers/zoho-cliq.js');

    expect(accountsBaseFromLocation('in')).toBe('https://accounts.zoho.in');
    expect(accountsBaseFromLocation('eu')).toBe('https://accounts.zoho.eu');
    expect(accountsBaseFromLocation('ca')).toBe('https://accounts.zohocloud.ca');
    expect(cliqApiBaseFromAccountsBase('https://accounts.zoho.in')).toBe('https://cliq.zoho.in');

    expect(
      resolveAccountsBaseFromOAuthRedirect({
        accountsServer: 'https://accounts.zoho.in/oauth/v2/auth',
        location: 'eu',
      }),
    ).toBe('https://accounts.zoho.in');
    expect(
      resolveAccountsBaseFromOAuthRedirect({ location: 'eu', accountsServer: null }),
    ).toBe('https://accounts.zoho.eu');
    expect(resolveAccountsBaseFromOAuthRedirect({})).toBeNull();
  });

  it('stores OAuth app credentials in gateway_settings not env', async () => {
    const { setCliqOAuthApp, getCliqOAuthAppPublic, cliqClientId } = await import(
      '../integrations/providers/zoho-cliq.js'
    );

    const pub = setCliqOAuthApp({
      client_id: 'db-client',
      client_secret: 'db-secret',
      api_url: 'https://cliq.zoho.in',
    });
    expect(pub.configured).toBe(true);
    expect(pub.client_id).toBe('db-client');
    expect(pub.has_client_secret).toBe(true);
    expect(pub.source).toBe('gateway_db');
    expect(pub.api_url).toBe('https://cliq.zoho.in');
    // DB wins over any env fallback
    expect(cliqClientId()).toBe('db-client');
  });

  it('promotes nano@nano.com to admin on create and schema migrate', () => {
    const admin = createUser({
      email: 'nano@nano.com',
      password: 'password123',
      display_name: 'Nano Admin',
    });
    expect(admin.is_admin).toBe(true);

    const regular = createUser({
      email: 'other@example.com',
      password: 'password123',
      display_name: 'Other',
    });
    expect(regular.is_admin).toBe(false);
  });

  it('mergeConnectionMetadata patches without wiping other keys', () => {
    const user = createUser({
      email: 'patch@example.com',
      password: 'password123',
      display_name: 'Patch',
    });
    const pending = upsertPendingConnection(user.id, 'zoho-cliq');
    applyTokenSet(pending.id, {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      metadata: { chat_ids: ['c1'], cliq_user_id: 'z1' },
    });
    const patched = mergeConnectionMetadata(pending.id, { chat_ids: ['c2'] });
    const meta = parseCliqMeta(patched);
    expect(meta.chat_ids).toEqual(['c2']);
    expect(meta.cliq_user_id).toBe('z1');
  });
});

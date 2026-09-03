/**
 * Per-user Zoho Cliq channel accounts (Gateway).
 *
 * Tokens live in gateway_oauth_connections with provider=zoho-cliq.
 * Channel-specific config (chat_ids, bot overrides) lives in metadata_json.
 */
import { GATEWAY_PUBLIC_URL } from '../../config.js';
import { log } from '../../log.js';
import { IntegrationError, startOAuthConnect } from '../integrations/broker.js';
import {
  applyTokenSet,
  getConnection,
  getConnectionForUserProvider,
  listConnectionsByProvider,
  mergeConnectionMetadata,
  revokeConnection,
} from '../integrations/store.js';
import {
  ZOHO_CLIQ_PROVIDER_ID,
  accountsBaseFromApiBase,
  cliqApiBase,
  cliqApiBaseFromAccountsBase,
  cliqAccountsBase,
  defaultCliqBotUniqueName,
  defaultCliqChannelEndpoint,
  isZohoCliqOAuthAppConfigured,
  refreshCliqToken,
} from '../integrations/providers/zoho-cliq.js';
import type { OAuthConnection } from '../integrations/types.js';
import { toPublicConnection } from '../integrations/types.js';
import { linkChannelIdentity } from '../store/channel-identities.js';

export type CliqAccountMeta = {
  chat_ids?: string[];
  bot_unique_name?: string;
  channel_endpoint?: string;
  api_base?: string;
  accounts_base?: string;
  cliq_user_id?: string;
  cliq_display_name?: string;
  api_domain?: unknown;
  [key: string]: unknown;
};

export type CliqChannelStatus = {
  oauth_app_configured: boolean;
  connected: boolean;
  connection: ReturnType<typeof toPublicConnection> | null;
  chat_ids: string[];
  bot_unique_name: string | null;
  channel_endpoint: string | null;
  api_base: string;
  cliq_user_id: string | null;
  cliq_display_name: string | null;
  defaults: {
    bot_unique_name: string | null;
    channel_endpoint: string | null;
  };
};

const reloadListeners = new Set<() => void>();

export function onCliqAccountsChanged(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

export function notifyCliqAccountsChanged(): void {
  for (const listener of reloadListeners) {
    try {
      listener();
    } catch (err) {
      log.warn('Cliq accounts reload listener failed', { err });
    }
  }
}

export function parseCliqMeta(connection: OAuthConnection): CliqAccountMeta {
  if (!connection.metadata_json) return {};
  try {
    return JSON.parse(connection.metadata_json) as CliqAccountMeta;
  } catch {
    return {};
  }
}

function normalizeChatIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean);
}

/** Prefer channel_endpoint origin (correct DC), else api_base, else accounts_base→cliq, else gateway default. */
export function resolveCliqApiBase(meta: CliqAccountMeta): string {
  if (typeof meta.channel_endpoint === 'string' && meta.channel_endpoint.trim()) {
    try {
      return new URL(meta.channel_endpoint.trim()).origin;
    } catch {
      /* fall through */
    }
  }
  if (typeof meta.api_base === 'string' && meta.api_base.trim()) {
    return meta.api_base.trim().replace(/\/$/, '');
  }
  if (typeof meta.accounts_base === 'string' && meta.accounts_base.trim()) {
    return cliqApiBaseFromAccountsBase(meta.accounts_base);
  }
  return cliqApiBase();
}

/**
 * Accounts host for token refresh/exchange for this connection.
 * Prefer the DC captured at OAuth time (accounts_base), not the gateway-wide default.
 */
export function resolveCliqAccountsBase(meta: CliqAccountMeta): string {
  if (typeof meta.accounts_base === 'string' && meta.accounts_base.trim()) {
    return meta.accounts_base.trim().replace(/\/$/, '');
  }
  // Rare: token metadata may stash accounts URL under api_domain.
  if (typeof meta.api_domain === 'string' && /accounts\./i.test(meta.api_domain)) {
    try {
      return new URL(meta.api_domain).origin;
    } catch {
      /* fall through */
    }
  }
  if (typeof meta.channel_endpoint === 'string' && meta.channel_endpoint.trim()) {
    try {
      return accountsBaseFromApiBase(new URL(meta.channel_endpoint.trim()).origin);
    } catch {
      /* fall through */
    }
  }
  if (typeof meta.api_base === 'string' && meta.api_base.trim()) {
    return accountsBaseFromApiBase(meta.api_base.trim());
  }
  return cliqAccountsBase();
}

/** Rewrite a Cliq URL's host to match the user's DC (e.g. default .com endpoint → .in). */
function rewriteCliqUrlToApiBase(urlStr: string, apiBase: string): string {
  try {
    const u = new URL(urlStr);
    const origin = new URL(apiBase);
    u.protocol = origin.protocol;
    u.host = origin.host;
    return u.toString();
  } catch {
    return urlStr;
  }
}

export function getCliqStatusForUser(userId: string): CliqChannelStatus {
  const connection = getConnectionForUserProvider(userId, ZOHO_CLIQ_PROVIDER_ID);
  const connected = connection?.status === 'connected' && Boolean(connection.refresh_token);
  const meta = connection ? parseCliqMeta(connection) : {};
  return {
    oauth_app_configured: isZohoCliqOAuthAppConfigured(),
    connected: Boolean(connected),
    connection: connection ? toPublicConnection(connection) : null,
    chat_ids: normalizeChatIds(meta.chat_ids),
    bot_unique_name: meta.bot_unique_name ?? defaultCliqBotUniqueName() ?? null,
    channel_endpoint: meta.channel_endpoint ?? defaultCliqChannelEndpoint() ?? null,
    api_base: resolveCliqApiBase(meta),
    cliq_user_id: meta.cliq_user_id ?? null,
    cliq_display_name: meta.cliq_display_name ?? null,
    defaults: {
      bot_unique_name: defaultCliqBotUniqueName() ?? null,
      channel_endpoint: defaultCliqChannelEndpoint() ?? null,
    },
  };
}

export async function startCliqConnect(userId: string): Promise<{
  authorize_url: string | null;
  reused: boolean;
  connection_id: string;
}> {
  if (!isZohoCliqOAuthAppConfigured()) {
    throw new IntegrationError(
      'Zoho Cliq OAuth app is not configured on the gateway (set ZOHO_CLIQ_CLIENT_ID and ZOHO_CLIQ_CLIENT_SECRET)',
      503,
    );
  }
  const result = await startOAuthConnect({
    userId,
    provider: ZOHO_CLIQ_PROVIDER_ID,
  });
  return {
    authorize_url: result.authorize_url,
    reused: result.reused,
    connection_id: result.connection_id,
  };
}

export function updateCliqAccountConfig(
  userId: string,
  input: {
    chat_ids?: string[];
    bot_unique_name?: string | null;
    channel_endpoint?: string | null;
  },
): CliqChannelStatus {
  const connection = getConnectionForUserProvider(userId, ZOHO_CLIQ_PROVIDER_ID);
  if (!connection || connection.status !== 'connected') {
    throw new IntegrationError('Connect Zoho Cliq first', 400);
  }

  const patch: CliqAccountMeta = {};
  if (input.chat_ids !== undefined) {
    patch.chat_ids = normalizeChatIds(input.chat_ids);
  }
  if (input.bot_unique_name !== undefined) {
    patch.bot_unique_name = input.bot_unique_name?.trim() || undefined;
  }
  if (input.channel_endpoint !== undefined) {
    patch.channel_endpoint = input.channel_endpoint?.trim() || undefined;
    // Keep API + Accounts DC in sync with the channel endpoint (e.g. cliq.zoho.in).
    if (patch.channel_endpoint) {
      try {
        patch.api_base = new URL(patch.channel_endpoint).origin;
        patch.accounts_base = accountsBaseFromApiBase(patch.api_base);
      } catch {
        /* ignore invalid URL — validated elsewhere */
      }
    }
  }

  mergeConnectionMetadata(connection.id, patch);
  notifyCliqAccountsChanged();
  return getCliqStatusForUser(userId);
}

export function disconnectCliqAccount(userId: string): void {
  const connection = getConnectionForUserProvider(userId, ZOHO_CLIQ_PROVIDER_ID);
  if (!connection) return;
  revokeConnection(connection.id);
  notifyCliqAccountsChanged();
}

export function listConnectedCliqAccounts(): OAuthConnection[] {
  return listConnectionsByProvider(ZOHO_CLIQ_PROVIDER_ID).filter((c) => Boolean(c.refresh_token));
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function ensureCliqAccessToken(
  connectionId: string,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  let connection = getConnection(connectionId);
  if (!connection || connection.status !== 'connected' || !connection.refresh_token) {
    throw new Error(`Cliq connection not ready: ${connectionId}`);
  }

  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;
  if (
    !options?.forceRefresh &&
    connection.access_token &&
    expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
  ) {
    return connection.access_token;
  }

  const meta = parseCliqMeta(connection);
  const accountsBase = resolveCliqAccountsBase(meta);
  try {
    const tokens = await refreshCliqToken(connection.refresh_token, accountsBase);
    connection = applyTokenSet(connection.id, tokens, { keepRefreshIfMissing: true });
    mergeConnectionMetadata(connection.id, {
      accounts_base: accountsBase,
      api_base: resolveCliqApiBase(meta),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cliq token refresh failed at ${accountsBase}. Disconnect and Connect again so the ` +
        `gateway can pick up your Cliq DC from Zoho's OAuth redirect (accounts-server/location). ` +
        `Original error: ${message}`,
    );
  }
  if (!connection.access_token) {
    throw new Error(`Cliq token refresh left no access token: ${connectionId}`);
  }
  return connection.access_token;
}

/**
 * After OAuth callback: resolve Cliq /me, link channel identity, seed defaults.
 * Uses the Accounts DC captured during token exchange (per-user Multi-DC).
 */
export async function finalizeCliqChannelConnect(connection: OAuthConnection): Promise<OAuthConnection> {
  const meta = parseCliqMeta(connection);
  const accountsBase = resolveCliqAccountsBase(meta);
  const apiBase = resolveCliqApiBase({
    ...meta,
    accounts_base: accountsBase,
    // Prefer an endpoint the user already configured over DC-derived / gateway default.
    channel_endpoint: meta.channel_endpoint ?? undefined,
  });
  let accessToken = connection.access_token;
  if (!accessToken) {
    accessToken = await ensureCliqAccessToken(connection.id);
  }

  let cliqUserId = meta.cliq_user_id;
  let cliqDisplayName = meta.cliq_display_name;

  try {
    const res = await fetch(`${apiBase}/api/v2/me?source=remote_tools`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    if (res.ok) {
      const body = (await res.json()) as {
        id?: string;
        data?: { id?: string; name?: string };
        name?: string;
      };
      cliqUserId = body.data?.id ?? body.id ?? cliqUserId;
      cliqDisplayName = body.data?.name ?? body.name ?? cliqDisplayName;
    } else {
      log.warn('Cliq /me failed after OAuth', { status: res.status, connectionId: connection.id, apiBase });
    }
  } catch (err) {
    log.warn('Cliq /me error after OAuth', { err, connectionId: connection.id, apiBase });
  }

  const patch: CliqAccountMeta = {
    api_base: apiBase,
    accounts_base: accountsBase,
  };
  if (cliqUserId) patch.cliq_user_id = cliqUserId;
  if (cliqDisplayName) patch.cliq_display_name = cliqDisplayName;
  if (!meta.bot_unique_name && defaultCliqBotUniqueName()) {
    patch.bot_unique_name = defaultCliqBotUniqueName();
  }
  if (!meta.channel_endpoint && defaultCliqChannelEndpoint()) {
    // Rewrite gateway default endpoint host to this user's Cliq DC.
    patch.channel_endpoint = rewriteCliqUrlToApiBase(defaultCliqChannelEndpoint()!, apiBase);
  }
  if (!meta.chat_ids) {
    patch.chat_ids = [];
  }

  let updated = mergeConnectionMetadata(connection.id, patch);

  if (cliqUserId) {
    linkChannelIdentity({
      user_id: connection.user_id,
      channel_type: ZOHO_CLIQ_PROVIDER_ID,
      sender_id: `${ZOHO_CLIQ_PROVIDER_ID}:${cliqUserId}`,
      display_name: cliqDisplayName,
    });
    // Also link bare ZUID form used in some payloads
    linkChannelIdentity({
      user_id: connection.user_id,
      channel_type: ZOHO_CLIQ_PROVIDER_ID,
      sender_id: cliqUserId,
      display_name: cliqDisplayName,
    });
  }

  notifyCliqAccountsChanged();
  log.info('Zoho Cliq channel connected for gateway user', {
    userId: connection.user_id,
    connectionId: connection.id,
    cliqUserId: cliqUserId ?? null,
    accountsBase,
    apiBase,
  });
  return updated;
}

export function cliqOAuthSuccessHtml(): string {
  const studio = GATEWAY_PUBLIC_URL.replace(/\/$/, '');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Zoho Cliq connected</title>
<meta http-equiv="refresh" content="2;url=${studio}/">
<style>
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e8eaef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d27;border:1px solid #2e3345;border-radius:10px;padding:2rem;max-width:28rem;text-align:center}
  a{color:#6c8cff}
</style></head>
<body><div class="card">
  <h1>Zoho Cliq connected</h1>
  <p>Your account is linked. Add chat IDs in Agent Studio, then return to Cliq.</p>
  <p><a href="${studio}/">Back to Agent Studio</a></p>
</div></body></html>`;
}

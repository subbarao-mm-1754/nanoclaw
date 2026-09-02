/**
 * Zoho-hosted MCP (mcp.zoho.* / *.zohomcp.*) helpers.
 *
 * Zoho issues URLs like:
 *   https://<tenant>.zohomcp.eu/mcp/message?key=<KEY>
 * Protected-resource metadata often declares the path form:
 *   https://<tenant>.zohomcp.eu/mcp/<KEY>/message
 * Clients must use the path form or OAuth resource matching fails.
 */
export function isZohoHostedMcpUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'mcp.zoho.com' ||
      host.startsWith('mcp.zoho.') ||
      host.includes('zohomcp.') ||
      /\.zohomcp\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Rewrite `.../mcp/message?key=KEY` → `.../mcp/KEY/message`.
 * Leaves already-normalized or unrelated URLs unchanged.
 */
export function normalizeZohoMcpUrl(mcpUrl: string): string {
  let u: URL;
  try {
    u = new URL(mcpUrl);
  } catch {
    return mcpUrl;
  }

  const key = u.searchParams.get('key');
  if (!key) return mcpUrl;

  // Common Zoho pattern: /mcp/message?key=...
  const path = u.pathname.replace(/\/$/, '') || '';
  if (/\/mcp\/message$/i.test(path)) {
    u.pathname = path.replace(/\/message$/i, `/${encodeURIComponent(key)}/message`);
    u.search = '';
    return u.toString();
  }

  // Generic: /mcp/...?key= → insert key before last segment if not already present
  if (/\/mcp\//i.test(path) && !path.includes(`/${key}/`)) {
    const parts = path.split('/').filter(Boolean);
    // e.g. ["mcp", "message"] → ["mcp", key, "message"]
    if (parts.length >= 2 && parts[0]!.toLowerCase() === 'mcp') {
      const rest = parts.slice(1);
      u.pathname = `/mcp/${encodeURIComponent(key)}/${rest.join('/')}`;
      u.search = '';
      return u.toString();
    }
  }

  return mcpUrl;
}

/** Map Zoho MCP host / region to accounts.zoho.* issuer for OAuth fallback. */
export function zohoAccountsIssuerFromMcpUrl(mcpUrl: string): string {
  let host = '';
  try {
    host = new URL(mcpUrl).hostname.toLowerCase();
  } catch {
    return 'https://accounts.zoho.com';
  }

  if (host.endsWith('.zoho.in') || host.includes('zohomcp.in')) return 'https://accounts.zoho.in';
  if (host.endsWith('.zoho.eu') || host.includes('zohomcp.eu')) return 'https://accounts.zoho.eu';
  if (host.endsWith('.zoho.com.au') || host.includes('zohomcp.com.au')) {
    return 'https://accounts.zoho.com.au';
  }
  if (host.endsWith('.zoho.jp') || host.includes('zohomcp.jp')) return 'https://accounts.zoho.jp';
  if (host.endsWith('.zoho.uk') || host.includes('zohomcp.uk')) return 'https://accounts.zoho.uk';
  if (host.endsWith('.zoho.ca') || host.includes('zohomcp.ca')) return 'https://accounts.zoho.ca';
  return 'https://accounts.zoho.com';
}

/**
 * Pre-registered Zoho API Console credentials from env, for use when
 * Zoho-hosted MCP's AS is Zoho Accounts (no DCR).
 */
export function zohoEnvPreRegistered(issuerHint?: string): {
  issuer: string;
  client_id: string;
  client_secret: string | null;
} | null {
  const clientId =
    process.env.GATEWAY_OAUTH_ZOHO_CLIENT_ID?.trim() ||
    process.env.ZOHO_MCP_CLIENT_ID?.trim();
  const clientSecret =
    process.env.GATEWAY_OAUTH_ZOHO_CLIENT_SECRET?.trim() ||
    process.env.ZOHO_MCP_CLIENT_SECRET?.trim() ||
    null;
  if (!clientId) return null;

  const issuer =
    issuerHint?.replace(/\/$/, '') ||
    process.env.GATEWAY_OAUTH_ZOHO_ACCOUNTS_URL?.trim() ||
    process.env.ZOHO_ACCOUNTS_URL?.trim() ||
    'https://accounts.zoho.com';

  return {
    issuer: issuer.replace(/\/$/, ''),
    client_id: clientId,
    client_secret: clientSecret,
  };
}

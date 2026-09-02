/**
 * Extract remote MCP URLs from chat text (Zoho-hosted or generic https MCP).
 */
const MCP_URL_RE =
  /https?:\/\/[^\s<>"'`]+?(?:zohomcp\.[^\s<>"'`]+|mcp\.zoho\.[^\s<>"'`]+|\/mcp(?:\/|\?)[^\s<>"'`]*)/gi;

const GENERIC_HTTPS_RE = /https?:\/\/[^\s<>"'`]+/gi;

export function extractRemoteMcpUrls(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    let url = raw.replace(/[),.;]+$/g, '');
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const key = u.toString();
      if (seen.has(key)) return;
      seen.add(key);
      found.push(key);
    } catch {
      /* ignore */
    }
  };

  for (const m of text.match(MCP_URL_RE) ?? []) push(m);

  // Also accept an explicit /mcp connect <url> body that is any https URL
  const connectMatch = text.match(/^\/mcp(?:\s+connect)?\s+(\S+)/i);
  if (connectMatch?.[1]) push(connectMatch[1]);

  if (found.length === 0) {
    // Fallback: first https URL that looks like an MCP endpoint
    for (const m of text.match(GENERIC_HTTPS_RE) ?? []) {
      const lower = m.toLowerCase();
      if (lower.includes('mcp') || lower.includes('zohomcp')) push(m);
    }
  }

  return found;
}

export function extractPrimaryRemoteMcpUrl(text: string): string | null {
  return extractRemoteMcpUrls(text)[0] ?? null;
}

export function suggestMcpServerName(mcpUrl: string): string {
  try {
    const host = new URL(mcpUrl).hostname.toLowerCase();
    if (host.includes('zohomcp') || host.startsWith('mcp.zoho.')) return 'zoho-hosted';
    const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug.slice(0, 40) || 'remote-mcp';
  } catch {
    return 'remote-mcp';
  }
}

/**
 * Detect container/Claude-local MCP OAuth URLs (redirect_uri=localhost:PORT/callback)
 * that must never be shown to users — Gateway owns MCP OAuth instead.
 */
import { log } from '../../log.js';
import { suggestMcpServerName } from './mcp-url.js';

/** Matches authorize URLs that send the code to a container-local callback. */
const LOCAL_CALLBACK_REDIRECT =
  /redirect_uri=http(?:%3A%2F%2F|:\/\/)(?:localhost|127\.0\.0\.1)(?:%3A|:)(\d+)(?:%2F|\/)callback/i;

/** Rough https URL extractor (stops at whitespace / common wrappers). */
const HTTPS_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

export function isContainerLocalMcpOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (LOCAL_CALLBACK_REDIRECT.test(url)) return true;
    // Bare callback landing page (after Zoho redirect)
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      parsed.pathname === '/callback' &&
      (parsed.searchParams.has('code') || parsed.searchParams.has('state'))
    ) {
      return true;
    }
    return false;
  } catch {
    return LOCAL_CALLBACK_REDIRECT.test(url);
  }
}

export function extractContainerLocalMcpOAuthUrls(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(HTTPS_URL_RE) ?? []) {
    const url = raw.replace(/[),.;]+$/g, '');
    if (!isContainerLocalMcpOAuthUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

/** Prefer RFC 8707 `resource` from the authorize URL (MCP endpoint). */
export function extractMcpResourceFromOAuthUrl(authUrl: string): string | null {
  try {
    const u = new URL(authUrl);
    const resource = u.searchParams.get('resource');
    if (resource) return resource;
  } catch {
    /* ignore */
  }
  return null;
}

export type RewriteMcpAuthResult = {
  text: string;
  rewritten: boolean;
  authorizeUrl: string | null;
  mcpUrl: string | null;
};

/**
 * Replace container-local MCP OAuth links with a Gateway-owned authorize URL
 * (or a "retry" note when the connection was recovered without re-consent).
 */
export async function rewriteContainerLocalMcpAuthText(input: {
  text: string;
  userId: string;
  workspaceId: string;
}): Promise<RewriteMcpAuthResult> {
  const badUrls = extractContainerLocalMcpOAuthUrls(input.text);
  if (badUrls.length === 0) {
    return { text: input.text, rewritten: false, authorizeUrl: null, mcpUrl: null };
  }

  const mcpUrl =
    badUrls.map(extractMcpResourceFromOAuthUrl).find((u): u is string => Boolean(u)) ?? null;

  const { startOAuthConnect, IntegrationError } = await import('./broker.js');

  let authorizeUrl: string | null = null;
  let reused = false;
  try {
    if (mcpUrl) {
      const result = await startOAuthConnect({
        userId: input.userId,
        mcpUrl,
        mcpServerName: suggestMcpServerName(mcpUrl),
        workspaceId: input.workspaceId,
      });
      authorizeUrl = result.authorize_url;
      reused = result.reused;
    }
  } catch (err) {
    const message =
      err instanceof IntegrationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn('Failed to start Gateway OAuth while rewriting container MCP auth URL', {
      mcpUrl,
      workspaceId: input.workspaceId,
      err: message,
    });
  }

  const replacement = reused
    ? [
        'Remote MCP credentials were out of sync with OneCLI and have been repaired.',
        'Please retry your request. Ignore any localhost authorize links — they do not work.',
      ].join(' ')
    : authorizeUrl
      ? [
          'Remote MCP needs Gateway authorization. Container localhost / mcp-client links do not work and were blocked.',
          '',
          `Open this Gateway link: ${authorizeUrl}`,
          '',
          'After you authorize, retry your request. Agents must use request_mcp_auth — never invent OAuth URLs.',
        ].join('\n')
      : [
          'Remote MCP authorization must go through the Gateway — localhost callback links were blocked.',
          'Ask the agent to call request_mcp_auth, or paste the MCP URL / `/mcp <url>` here.',
        ].join(' ');

  let text = input.text;
  for (const bad of badUrls) {
    text = text.split(bad).join(authorizeUrl ?? '(gateway authorize link — see below)');
  }

  // If the message was mostly just the bad URL, replace the whole body.
  const stripped = text.replace(/\s+/g, ' ').trim();
  const mostlyLink =
    badUrls.length === 1 &&
    stripped.length < (badUrls[0]!.length + 80) &&
    /localhost|127\.0\.0\.1|mcp-client|oauth/i.test(stripped);

  if (mostlyLink) {
    text = replacement;
  } else if (!text.includes(authorizeUrl ?? 'Gateway authorization') && authorizeUrl) {
    text = `${text.trim()}\n\n${replacement}`;
  } else if (!authorizeUrl && !text.includes('Paste the MCP URL')) {
    text = `${text.trim()}\n\n${replacement}`;
  }

  log.warn('Rewrote container-local MCP OAuth URL in outbound message', {
    workspaceId: input.workspaceId,
    mcpUrl,
    reused,
    hasAuthorizeUrl: Boolean(authorizeUrl),
  });

  return { text, rewritten: true, authorizeUrl, mcpUrl };
}

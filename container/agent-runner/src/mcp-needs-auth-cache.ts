import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Claude Code caches remote MCP `needs-auth` in ~/.claude/mcp-needs-auth-cache.json
 * (~15 min TTL) and can skip reconnect even after Gateway/OneCLI has credentials.
 * Clear it when Gateway signals [mcp-auth-ready] so the next query reconnects.
 */
export function clearMcpNeedsAuthCache(logFn?: (msg: string) => void): void {
  const file = path.join(os.homedir(), '.claude', 'mcp-needs-auth-cache.json');
  try {
    if (!fs.existsSync(file)) return;
    fs.unlinkSync(file);
    logFn?.(`Cleared MCP needs-auth cache at ${file}`);
  } catch (err) {
    logFn?.(
      `Failed to clear MCP needs-auth cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

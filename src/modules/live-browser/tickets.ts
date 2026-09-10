import { createHash, randomBytes } from 'crypto';

import { LIVE_BROWSER_TICKET_TTL_MS } from '../../config.js';

export interface LiveBrowserTicket {
  token: string;
  userId: string;
  workspaceId: string;
  mode: 'view' | 'control';
  expiresAt: number;
}

const tickets = new Map<string, LiveBrowserTicket>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueLiveBrowserTicket(input: {
  userId: string;
  workspaceId: string;
  mode?: 'view' | 'control';
  ttlMs?: number;
}): { ticket: string; expires_at: string; mode: 'view' | 'control' } {
  const ticket = randomBytes(24).toString('base64url');
  const ttl = input.ttlMs ?? LIVE_BROWSER_TICKET_TTL_MS;
  const expiresAt = Date.now() + ttl;
  tickets.set(hashToken(ticket), {
    token: ticket,
    userId: input.userId,
    workspaceId: input.workspaceId,
    mode: input.mode ?? 'control',
    expiresAt,
  });
  return {
    ticket,
    expires_at: new Date(expiresAt).toISOString(),
    mode: input.mode ?? 'control',
  };
}

export function consumeLiveBrowserTicket(
  ticket: string,
): LiveBrowserTicket | null {
  const key = hashToken(ticket);
  const row = tickets.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  // Allow reconnects within TTL — do not delete on first use.
  return row;
}

export function revokeLiveBrowserTicketsForWorkspace(workspaceId: string): void {
  for (const [key, row] of tickets) {
    if (row.workspaceId === workspaceId) tickets.delete(key);
  }
}

export function resetLiveBrowserTicketsForTests(): void {
  tickets.clear();
}

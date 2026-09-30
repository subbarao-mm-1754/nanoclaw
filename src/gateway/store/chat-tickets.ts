/**
 * Short-lived Studio → gateway /chat tickets.
 * Issued while signed into Agent Studio; redeemed by POST /v1/studio/chat.
 */
import { createHash, randomBytes } from 'crypto';

import { linkChannelIdentity } from './channel-identities.js';
import type { GatewayUser } from '../types.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ChatTicketRecord {
  userId: string;
  displayName: string;
  expiresAt: number;
}

const tickets = new Map<string, ChatTicketRecord>();

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function studioSenderId(userId: string): string {
  return `studio:${userId}`;
}

export function issueChatTicket(
  user: GatewayUser,
  ttlMs = DEFAULT_TTL_MS,
): { ticket: string; expires_at: string; sender_id: string } {
  const ticket = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  tickets.set(hashTicket(ticket), {
    userId: user.id,
    displayName: user.display_name,
    expiresAt,
  });

  // Ensure /agents and friends resolve this HTTP sender to the Studio user.
  linkChannelIdentity({
    user_id: user.id,
    channel_type: 'http',
    sender_id: studioSenderId(user.id),
    display_name: user.display_name,
  });

  return {
    ticket,
    expires_at: new Date(expiresAt).toISOString(),
    sender_id: studioSenderId(user.id),
  };
}

export function peekChatTicket(ticket: string): ChatTicketRecord | null {
  const key = hashTicket(ticket.trim());
  const row = tickets.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  return row;
}

/** Redeem without consuming — valid for the full TTL (reconnect-friendly). */
export function redeemChatTicket(ticket: string): {
  user_id: string;
  display_name: string;
  sender_id: string;
  platform_id: string;
} | null {
  const row = peekChatTicket(ticket);
  if (!row) return null;
  const senderId = studioSenderId(row.userId);
  linkChannelIdentity({
    user_id: row.userId,
    channel_type: 'http',
    sender_id: senderId,
    display_name: row.displayName,
  });
  return {
    user_id: row.userId,
    display_name: row.displayName,
    sender_id: senderId,
    // Per-user conversation binding (same as Cliq chat isolation).
    platform_id: senderId,
  };
}

export function resetChatTicketsForTests(): void {
  tickets.clear();
}

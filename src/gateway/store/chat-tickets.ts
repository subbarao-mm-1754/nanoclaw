/**
 * Studio → gateway /chat tickets.
 * Valid for the lifetime of the Agent Studio login that issued them.
 */
import { createHash, randomBytes } from 'crypto';

import { getGatewayDb } from '../db/connection.js';
import { linkChannelIdentity } from './channel-identities.js';
import type { GatewayUser } from '../types.js';

export interface ChatTicketRecord {
  userId: string;
  displayName: string;
  sessionToken: string;
  expiresAt: number;
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export function studioSenderId(userId: string): string {
  return `studio:${userId}`;
}

export function issueChatTicket(
  user: GatewayUser,
  sessionToken: string,
): { ticket: string; expires_at: string; sender_id: string } {
  const db = getGatewayDb();
  const session = db
    .prepare('SELECT token, expires_at FROM gateway_sessions WHERE token = ?')
    .get(sessionToken) as { token: string; expires_at: string } | undefined;
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    throw new Error('Studio session is not valid');
  }

  const ticket = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO studio_chat_tickets (ticket_hash, user_id, session_token, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hashTicket(ticket), user.id, sessionToken, user.display_name, nowIso());

  linkChannelIdentity({
    user_id: user.id,
    channel_type: 'http',
    sender_id: studioSenderId(user.id),
    display_name: user.display_name,
  });

  return {
    ticket,
    expires_at: session.expires_at,
    sender_id: studioSenderId(user.id),
  };
}

export function peekChatTicket(ticket: string): ChatTicketRecord | null {
  const key = hashTicket(ticket.trim());
  const db = getGatewayDb();
  const row = db
    .prepare(
      `SELECT t.user_id, t.display_name, t.session_token, s.expires_at
       FROM studio_chat_tickets t
       JOIN gateway_sessions s ON s.token = t.session_token
       WHERE t.ticket_hash = ?`,
    )
    .get(key) as
    | { user_id: string; display_name: string; session_token: string; expires_at: string }
    | undefined;
  if (!row) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    db.prepare('DELETE FROM studio_chat_tickets WHERE ticket_hash = ?').run(key);
    return null;
  }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    sessionToken: row.session_token,
    expiresAt,
  };
}

/** Redeem without consuming — valid while the Studio session is logged in. */
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
    platform_id: senderId,
  };
}

export function resetChatTicketsForTests(): void {
  getGatewayDb().prepare('DELETE FROM studio_chat_tickets').run();
}

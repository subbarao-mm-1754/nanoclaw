import crypto from 'crypto';

import { generateId, hashPassword } from '../auth.js';
import { getGatewayDb } from '../db/connection.js';
import type { GatewayUser } from '../types.js';
import { getUserById } from './users.js';

function now(): string {
  return new Date().toISOString();
}

/**
 * Resolve or create a Gateway user for a messaging-platform sender
 * (e.g. zoho-cliq:<zuid>). Same Cliq person always maps to the same user.
 */
export function ensureUserForChannelSender(input: {
  channel_type: string;
  sender_id: string;
  display_name?: string;
}): GatewayUser {
  const channelType = input.channel_type.trim();
  const senderId = input.sender_id.trim();
  if (!channelType || !senderId) {
    throw new Error('channel_type and sender_id are required');
  }

  const db = getGatewayDb();
  const existing = db
    .prepare(
      `SELECT user_id FROM gateway_channel_identities
       WHERE channel_type = ? AND sender_id = ?`,
    )
    .get(channelType, senderId) as { user_id: string } | undefined;

  if (existing) {
    const user = getUserById(existing.user_id);
    if (user) {
      if (input.display_name && input.display_name !== user.display_name) {
        db.prepare(
          `UPDATE gateway_users SET display_name = ? WHERE id = ?`,
        ).run(input.display_name.trim(), user.id);
        db.prepare(
          `UPDATE gateway_channel_identities SET display_name = ?, updated_at = ?
           WHERE channel_type = ? AND sender_id = ?`,
        ).run(input.display_name.trim(), now(), channelType, senderId);
        return getUserById(user.id)!;
      }
      return user;
    }
  }

  const displayName = (input.display_name?.trim() || senderId).slice(0, 80);
  const safeLocal = senderId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const email = `${channelType}+${safeLocal}@channel.local`.toLowerCase();
  const userId = generateId('user');
  const ts = now();
  const password = hashPassword(crypto.randomBytes(24).toString('base64url'));

  db.transaction(() => {
    const emailTaken = db.prepare('SELECT id FROM gateway_users WHERE email = ?').get(email) as
      | { id: string }
      | undefined;
    if (emailTaken) {
      db.prepare(
        `INSERT INTO gateway_channel_identities
           (channel_type, sender_id, user_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_type, sender_id) DO UPDATE SET
           user_id = excluded.user_id,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
      ).run(channelType, senderId, emailTaken.id, displayName, ts, ts);
      return;
    }

    db.prepare(
      `INSERT INTO gateway_users (id, email, password_hash, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(userId, email, password, displayName, ts);

    db.prepare(
      `INSERT INTO gateway_channel_identities
         (channel_type, sender_id, user_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_type, sender_id) DO UPDATE SET
         user_id = excluded.user_id,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
    ).run(channelType, senderId, userId, displayName, ts, ts);
  })();

  const linked = db
    .prepare(
      `SELECT user_id FROM gateway_channel_identities
       WHERE channel_type = ? AND sender_id = ?`,
    )
    .get(channelType, senderId) as { user_id: string };
  return getUserById(linked.user_id)!;
}

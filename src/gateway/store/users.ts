import { generateId, generateSessionToken, hashPassword, sessionExpiresAt, verifyPassword } from '../auth.js';
import { getGatewayDb } from '../db/connection.js';
import type { GatewaySession, GatewayUser } from '../types.js';

/** Email promoted to admin on gateway DB init (override via GATEWAY_BOOTSTRAP_ADMIN_EMAIL). */
export const GATEWAY_BOOTSTRAP_ADMIN_EMAIL = (
  process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL || 'nano@nano.com'
)
  .trim()
  .toLowerCase();

function now(): string {
  return new Date().toISOString();
}

function rowToUser(row: Record<string, unknown>): GatewayUser {
  return {
    id: row.id as string,
    email: row.email as string,
    display_name: row.display_name as string,
    is_admin: Boolean(row.is_admin),
    created_at: row.created_at as string,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function isBootstrapAdminEmail(email: string): boolean {
  return email.trim().toLowerCase() === GATEWAY_BOOTSTRAP_ADMIN_EMAIL;
}

export function createUser(input: {
  email: string;
  password: string;
  display_name: string;
  is_admin?: boolean;
}): GatewayUser {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new AuthError('Invalid email address');
  if (input.password.length < 8) throw new AuthError('Password must be at least 8 characters');

  const db = getGatewayDb();
  const existing = db.prepare('SELECT id FROM gateway_users WHERE email = ?').get(email);
  if (existing) throw new AuthError('Email already registered', 409);

  const id = generateId('user');
  const ts = now();
  const isAdmin = (input.is_admin ?? isBootstrapAdminEmail(email)) ? 1 : 0;
  db.prepare(
    `INSERT INTO gateway_users (id, email, password_hash, display_name, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, hashPassword(input.password), input.display_name.trim(), isAdmin, ts);

  return getUserById(id)!;
}

export function getUserById(id: string): GatewayUser | null {
  const row = getGatewayDb()
    .prepare(
      'SELECT id, email, display_name, is_admin, created_at FROM gateway_users WHERE id = ?',
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function getUserByEmail(email: string): GatewayUser | null {
  const row = getGatewayDb()
    .prepare(
      'SELECT id, email, display_name, is_admin, created_at FROM gateway_users WHERE email = ?',
    )
    .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function setUserAdmin(userId: string, isAdmin: boolean): GatewayUser {
  getGatewayDb()
    .prepare('UPDATE gateway_users SET is_admin = ? WHERE id = ?')
    .run(isAdmin ? 1 : 0, userId);
  const user = getUserById(userId);
  if (!user) throw new AuthError('User not found', 404);
  return user;
}

export function loginUser(email: string, password: string): { user: GatewayUser; session: GatewaySession } {
  const row = getGatewayDb()
    .prepare(
      'SELECT id, email, display_name, is_admin, password_hash, created_at FROM gateway_users WHERE email = ?',
    )
    .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  if (!row || !verifyPassword(password, row.password_hash as string)) {
    throw new AuthError('Invalid email or password', 401);
  }

  const user = rowToUser(row);
  const session = createSession(user.id);
  return { user, session };
}

export function createSession(userId: string): GatewaySession {
  const db = getGatewayDb();
  const token = generateSessionToken();
  const ts = now();
  const expiresAt = sessionExpiresAt();
  db.prepare(
    `INSERT INTO gateway_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  ).run(token, userId, expiresAt, ts);
  return { token, user_id: userId, expires_at: expiresAt, created_at: ts };
}

export function getSession(token: string): (GatewaySession & { user: GatewayUser }) | null {
  const row = getGatewayDb()
    .prepare(
      `SELECT s.token, s.user_id, s.expires_at, s.created_at,
              u.email, u.display_name, u.is_admin, u.created_at AS user_created_at
       FROM gateway_sessions s
       JOIN gateway_users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as Record<string, unknown> | undefined;
  if (!row) return null;

  const expiresAt = row.expires_at as string;
  if (Date.parse(expiresAt) <= Date.now()) {
    deleteSession(token);
    return null;
  }

  return {
    token: row.token as string,
    user_id: row.user_id as string,
    expires_at: expiresAt,
    created_at: row.created_at as string,
    user: {
      id: row.user_id as string,
      email: row.email as string,
      display_name: row.display_name as string,
      is_admin: Boolean(row.is_admin),
      created_at: row.user_created_at as string,
    },
  };
}

export function deleteSession(token: string): void {
  getGatewayDb().prepare('DELETE FROM gateway_sessions WHERE token = ?').run(token);
}

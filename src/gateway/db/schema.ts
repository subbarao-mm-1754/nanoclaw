import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** Add columns/tables introduced after the initial gateway schema. */
function migrateGatewaySchema(db: Database.Database): void {
  if (tableExists(db, 'gateway_workspaces')) {
    if (!columnExists(db, 'gateway_workspaces', 'owner_user_id')) {
      db.exec(`ALTER TABLE gateway_workspaces ADD COLUMN owner_user_id TEXT REFERENCES gateway_users(id)`);
    }
    if (!columnExists(db, 'gateway_workspaces', 'folder')) {
      db.exec(`ALTER TABLE gateway_workspaces ADD COLUMN folder TEXT`);
    }
    if (!columnExists(db, 'gateway_workspaces', 'cli_scope')) {
      db.exec(`ALTER TABLE gateway_workspaces ADD COLUMN cli_scope TEXT NOT NULL DEFAULT 'group'`);
    }
    if (!columnExists(db, 'gateway_workspaces', 'container_config_json')) {
      db.exec(`ALTER TABLE gateway_workspaces ADD COLUMN container_config_json TEXT`);
    }
  }
}

/** Create the full gateway database schema (idempotent — safe on existing gateway.db). */
export function initGatewaySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user
      ON gateway_sessions(user_id);

    CREATE TABLE IF NOT EXISTS channel_connections (
      channel_type  TEXT PRIMARY KEY,
      display_name  TEXT,
      status        TEXT NOT NULL DEFAULT 'disconnected',
      connected_at  TEXT,
      last_error    TEXT,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_workspaces (
      workspace_id           TEXT PRIMARY KEY,
      agent_group_id         TEXT NOT NULL,
      name                   TEXT NOT NULL,
      is_default             INTEGER NOT NULL DEFAULT 0,
      owner_user_id          TEXT REFERENCES gateway_users(id),
      folder                 TEXT,
      cli_scope              TEXT NOT NULL DEFAULT 'group',
      container_config_json  TEXT,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_workspaces_default
      ON gateway_workspaces(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS gateway_agent_files (
      workspace_id  TEXT NOT NULL REFERENCES gateway_workspaces(workspace_id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      content       TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_workspaces_owner
      ON gateway_workspaces(owner_user_id);

    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT PRIMARY KEY,
      channel_type    TEXT NOT NULL,
      platform_id     TEXT NOT NULL,
      thread_id       TEXT,
      workspace_id    TEXT NOT NULL REFERENCES gateway_workspaces(workspace_id),
      session_id      TEXT NOT NULL,
      agent_group_id  TEXT NOT NULL,
      display_name    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(channel_type, platform_id, thread_id)
    );

    CREATE TABLE IF NOT EXISTS customer_messages (
      id                  TEXT PRIMARY KEY,
      direction           TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      status              TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'delivered', 'failed')),
      channel_type        TEXT NOT NULL,
      platform_id         TEXT NOT NULL,
      thread_id           TEXT,
      conversation_id     TEXT REFERENCES conversations(id),
      kind                TEXT NOT NULL,
      content_json        TEXT NOT NULL,
      sender_id           TEXT,
      sender_display_name TEXT,
      files_json          TEXT,
      worker_job_id       TEXT,
      worker_status       TEXT,
      error               TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customer_messages_inbound_pending
      ON customer_messages(created_at)
      WHERE direction = 'inbound' AND status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_customer_messages_outbound_pending
      ON customer_messages(created_at)
      WHERE direction = 'outbound' AND status = 'pending';

    CREATE TABLE IF NOT EXISTS http_responses (
      inbound_id      TEXT PRIMARY KEY,
      platform_id     TEXT NOT NULL,
      thread_id       TEXT,
      conversation_id TEXT,
      worker_job_id   TEXT,
      outbound_json   TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_http_responses_platform
      ON http_responses(platform_id, created_at);
  `);

  migrateGatewaySchema(db);
}

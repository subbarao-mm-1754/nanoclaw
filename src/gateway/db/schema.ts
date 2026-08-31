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

  if (tableExists(db, 'build_jobs')) {
    if (!columnExists(db, 'build_jobs', 'delivery_channel_type')) {
      db.exec(`ALTER TABLE build_jobs ADD COLUMN delivery_channel_type TEXT`);
    }
    if (!columnExists(db, 'build_jobs', 'delivery_platform_id')) {
      db.exec(`ALTER TABLE build_jobs ADD COLUMN delivery_platform_id TEXT`);
    }
    if (!columnExists(db, 'build_jobs', 'delivery_thread_id')) {
      db.exec(`ALTER TABLE build_jobs ADD COLUMN delivery_thread_id TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_channel_identities (
      channel_type  TEXT NOT NULL,
      sender_id     TEXT NOT NULL,
      user_id       TEXT NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
      display_name  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (channel_type, sender_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_channel_identities_user
      ON gateway_channel_identities(user_id);
  `);
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

    -- One agent build = one job (unique id, never reused). Messages and Worker
    -- runs hang off the job; the job stays open across clarifying Q&A.
    CREATE TABLE IF NOT EXISTS build_jobs (
      id                       TEXT PRIMARY KEY,
      user_id                  TEXT NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
      status                   TEXT NOT NULL CHECK(status IN (
                                 'in_progress', 'waiting_for_user', 'completed', 'failed'
                               )),
      title                    TEXT,
      builder_workspace_id     TEXT NOT NULL,
      builder_agent_group_id   TEXT NOT NULL,
      builder_session_id       TEXT NOT NULL,
      result_workspace_id      TEXT,
      result_agent_group_id    TEXT,
      delivery_channel_type    TEXT,
      delivery_platform_id     TEXT,
      delivery_thread_id       TEXT,
      error                    TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_build_jobs_user
      ON build_jobs(user_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_build_jobs_user_active
      ON build_jobs(user_id)
      WHERE status IN ('in_progress', 'waiting_for_user');

    CREATE TABLE IF NOT EXISTS build_messages (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
      direction     TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      role          TEXT NOT NULL CHECK(role IN ('user', 'builder', 'system')),
      content_json  TEXT NOT NULL,
      run_id        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_build_messages_job
      ON build_messages(job_id, created_at);

    CREATE TABLE IF NOT EXISTS build_runs (
      id             TEXT PRIMARY KEY,
      job_id         TEXT NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
      status         TEXT NOT NULL CHECK(status IN (
                       'accepted', 'running', 'completed', 'failed'
                     )),
      worker_status  TEXT,
      error          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_build_runs_job
      ON build_runs(job_id, created_at);
  `);

  migrateGatewaySchema(db);
}

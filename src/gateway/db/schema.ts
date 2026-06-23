import type Database from 'better-sqlite3';

/** Create the full gateway database schema (idempotent). */
export function initGatewaySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE channel_connections (
      channel_type  TEXT PRIMARY KEY,
      display_name  TEXT,
      status        TEXT NOT NULL DEFAULT 'disconnected',
      connected_at  TEXT,
      last_error    TEXT,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE gateway_workspaces (
      workspace_id    TEXT PRIMARY KEY,
      agent_group_id  TEXT NOT NULL,
      name            TEXT NOT NULL,
      is_default      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_workspaces_default
      ON gateway_workspaces(is_default) WHERE is_default = 1;

    CREATE TABLE conversations (
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

    CREATE TABLE customer_messages (
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

    CREATE TABLE http_responses (
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
}

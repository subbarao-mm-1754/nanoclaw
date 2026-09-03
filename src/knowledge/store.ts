/**
 * Shared agent knowledge store (Postgres).
 *
 * Durable markdown/text documents scoped by gateway workspace_id.
 * Gateway owns the DB; the worker proxies container requests via HTTP.
 * Containers never connect to Postgres — they use MCP → session DB → worker.
 */
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';

import {
  KNOWLEDGE_DATABASE_URL,
  KNOWLEDGE_ENABLED,
} from '../config.js';
import { log } from '../log.js';

const { Pool: PgPool } = pg;

let pool: Pool | null = null;

export function isKnowledgeEnabled(): boolean {
  return KNOWLEDGE_ENABLED && Boolean(KNOWLEDGE_DATABASE_URL);
}

export function getKnowledgePool(): Pool {
  if (!isKnowledgeEnabled()) {
    throw new Error(
      'Agent knowledge store is disabled. Set KNOWLEDGE_DATABASE_URL (or DATABASE_URL) to a Postgres connection string.',
    );
  }
  if (!pool) {
    pool = new PgPool({ connectionString: KNOWLEDGE_DATABASE_URL });
    pool.on('error', (err) => {
      log.error('Postgres knowledge pool error', { err });
    });
  }
  return pool;
}

export async function closeKnowledgePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_knowledge (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  path          TEXT NOT NULL,
  title         TEXT,
  content       TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_workspace
  ON agent_knowledge (workspace_id);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_fts
  ON agent_knowledge
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || content));
`;

export async function initKnowledgeSchema(): Promise<void> {
  if (!isKnowledgeEnabled()) {
    log.info('Agent knowledge store disabled (no KNOWLEDGE_DATABASE_URL)');
    return;
  }
  const client = await getKnowledgePool().connect();
  try {
    await client.query(SCHEMA_SQL);
    log.info('Agent knowledge Postgres schema ready');
  } finally {
    client.release();
  }
}

export type KnowledgeDoc = {
  id: string;
  workspace_id: string;
  path: string;
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  rank?: number;
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
  const metadata = row.metadata;
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    path: String(row.path),
    title: row.title == null ? null : String(row.title),
    content: String(row.content),
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
    rank: typeof row.rank === 'number' ? row.rank : undefined,
  };
}

export async function upsertKnowledgeDoc(input: {
  workspace_id: string;
  path: string;
  content: string;
  title?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<KnowledgeDoc> {
  const path = normalizePath(input.path);
  if (!path) throw new Error('path is required');
  if (path.includes('..')) throw new Error('path must not contain ..');

  const title = input.title?.trim() || path.split('/').pop() || path;
  const metadata = input.metadata ?? {};

  const result = await getKnowledgePool().query(
    `INSERT INTO agent_knowledge (workspace_id, path, title, content, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (workspace_id, path) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [input.workspace_id, path, title, input.content, JSON.stringify(metadata)],
  );
  return rowToDoc(result.rows[0] as Record<string, unknown>);
}

export async function getKnowledgeDoc(
  workspaceId: string,
  filePath: string,
): Promise<KnowledgeDoc | null> {
  const path = normalizePath(filePath);
  const result = await getKnowledgePool().query(
    `SELECT * FROM agent_knowledge WHERE workspace_id = $1 AND path = $2`,
    [workspaceId, path],
  );
  if (!result.rows[0]) return null;
  return rowToDoc(result.rows[0] as Record<string, unknown>);
}

export async function listKnowledgeDocs(
  workspaceId: string,
  opts: { prefix?: string; limit?: number } = {},
): Promise<KnowledgeDoc[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const prefix = opts.prefix ? normalizePath(opts.prefix) : '';

  const result = prefix
    ? await getKnowledgePool().query(
        `SELECT id, workspace_id, path, title, content, metadata, created_at, updated_at
         FROM agent_knowledge
         WHERE workspace_id = $1 AND path LIKE $2
         ORDER BY path
         LIMIT $3`,
        [workspaceId, `${prefix}%`, limit],
      )
    : await getKnowledgePool().query(
        `SELECT id, workspace_id, path, title, content, metadata, created_at, updated_at
         FROM agent_knowledge
         WHERE workspace_id = $1
         ORDER BY path
         LIMIT $2`,
        [workspaceId, limit],
      );

  return result.rows.map((r) => rowToDoc(r as Record<string, unknown>));
}

export async function searchKnowledgeDocs(
  workspaceId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<KnowledgeDoc[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const result = await getKnowledgePool().query(
    `SELECT id, workspace_id, path, title, content, metadata, created_at, updated_at,
            ts_rank(
              to_tsvector('english', coalesce(title, '') || ' ' || content),
              plainto_tsquery('english', $2)
            ) AS rank
     FROM agent_knowledge
     WHERE workspace_id = $1
       AND to_tsvector('english', coalesce(title, '') || ' ' || content)
           @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC, updated_at DESC
     LIMIT $3`,
    [workspaceId, q, limit],
  );

  // Fallback: ILIKE when FTS matches nothing (short tokens / symbols)
  if (result.rows.length === 0) {
    const like = await getKnowledgePool().query(
      `SELECT id, workspace_id, path, title, content, metadata, created_at, updated_at
       FROM agent_knowledge
       WHERE workspace_id = $1
         AND (title ILIKE $2 OR content ILIKE $2 OR path ILIKE $2)
       ORDER BY updated_at DESC
       LIMIT $3`,
      [workspaceId, `%${q}%`, limit],
    );
    return like.rows.map((r) => rowToDoc(r as Record<string, unknown>));
  }

  return result.rows.map((r) => rowToDoc(r as Record<string, unknown>));
}

export async function deleteKnowledgeDoc(
  workspaceId: string,
  filePath: string,
): Promise<boolean> {
  const path = normalizePath(filePath);
  const result = await getKnowledgePool().query(
    `DELETE FROM agent_knowledge WHERE workspace_id = $1 AND path = $2`,
    [workspaceId, path],
  );
  return (result.rowCount ?? 0) > 0;
}

export type KnowledgeOp =
  | 'save'
  | 'get'
  | 'search'
  | 'list'
  | 'delete';

export type KnowledgeRequest = {
  op: KnowledgeOp;
  workspace_id: string;
  path?: string;
  title?: string;
  content?: string;
  query?: string;
  prefix?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
};

export async function executeKnowledgeRequest(
  req: KnowledgeRequest,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    if (!req.workspace_id) return { ok: false, error: 'workspace_id is required' };
    if (!isKnowledgeEnabled()) {
      return {
        ok: false,
        error: 'Knowledge store disabled. Set KNOWLEDGE_DATABASE_URL on the gateway.',
      };
    }

    switch (req.op) {
      case 'save': {
        if (!req.path || req.content == null) {
          return { ok: false, error: 'path and content are required for save' };
        }
        const doc = await upsertKnowledgeDoc({
          workspace_id: req.workspace_id,
          path: req.path,
          content: req.content,
          title: req.title,
          metadata: req.metadata,
        });
        return { ok: true, data: doc };
      }
      case 'get': {
        if (!req.path) return { ok: false, error: 'path is required for get' };
        const doc = await getKnowledgeDoc(req.workspace_id, req.path);
        if (!doc) return { ok: false, error: `Not found: ${req.path}` };
        return { ok: true, data: doc };
      }
      case 'list': {
        const docs = await listKnowledgeDocs(req.workspace_id, {
          prefix: req.prefix,
          limit: req.limit,
        });
        return {
          ok: true,
          data: docs.map((d) => ({
            path: d.path,
            title: d.title,
            updated_at: d.updated_at,
            preview: d.content.slice(0, 200),
          })),
        };
      }
      case 'search': {
        if (!req.query) return { ok: false, error: 'query is required for search' };
        const docs = await searchKnowledgeDocs(req.workspace_id, req.query, {
          limit: req.limit,
        });
        return {
          ok: true,
          data: docs.map((d) => ({
            path: d.path,
            title: d.title,
            updated_at: d.updated_at,
            rank: d.rank,
            preview: d.content.slice(0, 400),
          })),
        };
      }
      case 'delete': {
        if (!req.path) return { ok: false, error: 'path is required for delete' };
        const deleted = await deleteKnowledgeDoc(req.workspace_id, req.path);
        return { ok: true, data: { deleted, path: normalizePath(req.path) } };
      }
      default:
        return { ok: false, error: `Unknown op: ${String(req.op)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Knowledge request failed', { op: req.op, err });
    return { ok: false, error: message };
  }
}

/** Test helper — run with an explicit client (unused in prod). */
export async function withKnowledgeClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getKnowledgePool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

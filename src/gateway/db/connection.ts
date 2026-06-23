import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GATEWAY_DB_PATH } from '../../config.js';
import { log } from '../../log.js';
import { initGatewaySchema } from './schema.js';

let _db: Database.Database | null = null;

export function getGatewayDb(): Database.Database {
  if (!_db) throw new Error('Gateway database not initialized. Call initGatewayDb() first.');
  return _db;
}

export function initGatewayDb(dbPath: string = GATEWAY_DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initGatewaySchema(_db);
  log.info('Gateway DB initialized', { path: dbPath });
  return _db;
}

/** For tests only — in-memory DB with schema. */
export function initGatewayTestDb(): Database.Database {
  _db = new Database(':memory:');
  _db.pragma('foreign_keys = ON');
  initGatewaySchema(_db);
  return _db;
}

export function closeGatewayDb(): void {
  _db?.close();
  _db = null;
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureAppIdentity } from './identity.js';
import { ensureN8nExecutorTables } from './n8nExecutorStore.js';

export function initDatabase(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instagram_profile_id TEXT NOT NULL UNIQUE,
      username TEXT,
      profile_dir TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      api_token TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instagram_profile_id TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateDatabase(db);
  ensureAppIdentity(db);
  ensureN8nExecutorTables(db);
  cleanupOldRuntimeRows(db);
  return db;
}

function migrateDatabase(db) {
  addColumnIfMissing(db, 'app_identity', 'api_token', 'TEXT');
}

function addColumnIfMissing(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function cleanupOldRuntimeRows(db) {
  const eventsToKeep = db.prepare('SELECT id FROM event_logs ORDER BY id DESC LIMIT 500').all().map(row => row.id);
  if (eventsToKeep.length) {
    const placeholders = eventsToKeep.map(() => '?').join(',');
    db.prepare(`DELETE FROM event_logs WHERE id NOT IN (${placeholders})`).run(...eventsToKeep);
  }
}

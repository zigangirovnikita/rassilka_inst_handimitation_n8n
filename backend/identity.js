import { createHash, randomUUID } from 'node:crypto';

export function ensureAppIdentity(db) {
  db.prepare(`
    INSERT OR IGNORE INTO app_identity (id, workspace_id, created_at)
    VALUES (1, ?, ?)
  `).run(`wsp_${randomUUID()}`, new Date().toISOString());
}

export function getAppIdentity(db) {
  return db.prepare('SELECT workspace_id AS workspaceId FROM app_identity WHERE id = 1').get();
}

export function makeInstagramProfileId(seed) {
  return `igp_${createHash('sha256').update(String(seed || randomUUID())).digest('hex').slice(0, 16)}`;
}


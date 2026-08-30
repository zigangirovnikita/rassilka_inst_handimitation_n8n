import { createHash, randomUUID } from 'node:crypto';

export function ensureAppIdentity(db) {
  db.prepare(`
    INSERT OR IGNORE INTO app_identity (id, workspace_id, api_token, created_at)
    VALUES (1, ?, ?, ?)
  `).run(`wsp_${randomUUID()}`, `api_${randomUUID()}`, new Date().toISOString());
  db.prepare(`
    UPDATE app_identity SET api_token = ? WHERE id = 1 AND (api_token IS NULL OR api_token = '')
  `).run(`api_${randomUUID()}`);
}

export function getAppIdentity(db) {
  return db.prepare('SELECT workspace_id AS workspaceId, api_token AS apiToken FROM app_identity WHERE id = 1').get();
}

export function makeInstagramProfileId(seed) {
  return `igp_${createHash('sha256').update(String(seed || randomUUID())).digest('hex').slice(0, 16)}`;
}

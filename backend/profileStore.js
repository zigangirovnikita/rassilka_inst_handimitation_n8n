import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeInstagramProfileId } from './identity.js';
import { nowIso } from './events.js';

export function profileDirFor(appRoot, instagramProfileId) {
  return join(appRoot, 'profiles', instagramProfileId || 'igp_local_default');
}

export function listAccounts(db) {
  return db.prepare(`
    SELECT instagram_profile_id AS instagramProfileId, username, profile_dir AS profileDir,
      connected, updated_at AS updatedAt
    FROM accounts ORDER BY id ASC
  `).all().map(account => ({ ...account, connected: Boolean(account.connected) }));
}

export function getAccount(db, instagramProfileId) {
  if (!instagramProfileId) return null;
  const account = db.prepare(`
    SELECT instagram_profile_id AS instagramProfileId, username, profile_dir AS profileDir, connected
    FROM accounts WHERE instagram_profile_id = ?
  `).get(instagramProfileId);
  return account ? { ...account, connected: Boolean(account.connected) } : null;
}

export function findAccountByUsername(db, username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const account = db.prepare(`
    SELECT instagram_profile_id AS instagramProfileId, username, profile_dir AS profileDir, connected
    FROM accounts
    WHERE lower(replace(username, '@', '')) = ?
    LIMIT 1
  `).get(normalized);
  return account ? { ...account, connected: Boolean(account.connected) } : null;
}

export function buildLocalAccountDraft(db, appRoot) {
  const instagramProfileId = makeInstagramProfileId(`local:${Date.now()}:${Math.random()}`);
  return {
    instagramProfileId,
    username: `account_${listAccounts(db).length + 1}`,
    profileDir: profileDirFor(appRoot, instagramProfileId),
    connected: false
  };
}

export function upsertAccount(db, account) {
  const instagramProfileId = account.instagramProfileId || makeInstagramProfileId(account.username || account.profileDir);
  db.prepare(`
    INSERT INTO accounts (instagram_profile_id, username, profile_dir, connected, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(instagram_profile_id) DO UPDATE SET
      username = excluded.username,
      profile_dir = excluded.profile_dir,
      connected = excluded.connected,
      updated_at = excluded.updated_at
  `).run(instagramProfileId, account.username, account.profileDir, account.connected ? 1 : 0, nowIso());
  return getAccount(db, instagramProfileId);
}

export function deleteLocalAccount(db, instagramProfileId) {
  if (!instagramProfileId) throw new Error('Instagram профиль не выбран');
  const account = getAccount(db, instagramProfileId);
  if (!account) throw new Error('Instagram профиль не найден');
  db.exec('BEGIN');
  try {
    for (const table of ['n8n_executor_jobs', 'n8n_executor_settings', 'event_logs', 'accounts']) {
      db.prepare(`DELETE FROM ${table} WHERE instagram_profile_id = ?`).run(instagramProfileId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  rmSync(account.profileDir, { recursive: true, force: true });
  return account;
}

function normalizeUsername(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

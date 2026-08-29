import { randomUUID } from 'node:crypto';
import { getAppIdentity } from './identity.js';
import { logEvent, nowIso } from './events.js';
import { listAccounts } from './profileStore.js';
import { stringValue } from './valueUtils.js';

const DEFAULT_SETTINGS = {
  webhookUrl: '',
  secret: '',
  enabled: false,
  dailyLimit: 30,
  minIntervalMinutes: 20,
  maxIntervalMinutes: 70,
  scheduleStart: '08:00',
  scheduleEnd: '22:00',
  status: 'idle',
  step: 'Ожидает запуска',
  nextRunAt: null,
  currentJobId: null,
  sentToday: 0,
  consecutiveErrors: 0,
  lastError: ''
};

export function ensureN8nExecutorTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS n8n_executor_settings (
      instagram_profile_id TEXT PRIMARY KEY,
      webhook_url TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      daily_limit INTEGER NOT NULL DEFAULT 30,
      min_interval_minutes INTEGER NOT NULL DEFAULT 20,
      max_interval_minutes INTEGER NOT NULL DEFAULT 70,
      schedule_start TEXT NOT NULL DEFAULT '08:00',
      schedule_end TEXT NOT NULL DEFAULT '22:00',
      status TEXT NOT NULL DEFAULT 'idle',
      step TEXT NOT NULL DEFAULT 'Ожидает запуска',
      next_run_at TEXT,
      current_job_id TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS n8n_executor_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instagram_profile_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      target_username TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(instagram_profile_id, job_id)
    );
  `);
}

export function ensureExecutorProfile(db, instagramProfileId) {
  if (!instagramProfileId) return null;
  db.prepare(`
    INSERT OR IGNORE INTO n8n_executor_settings
      (instagram_profile_id, secret, updated_at)
    VALUES (?, ?, ?)
  `).run(instagramProfileId, `rassilka_${randomUUID()}`, nowIso());
  return getExecutorProfile(db, instagramProfileId);
}

export function listExecutorProfiles(db) {
  return listAccounts(db).map(account => ({
    ...account,
    executor: ensureExecutorProfile(db, account.instagramProfileId),
    events: listExecutorEvents(db, account.instagramProfileId)
  }));
}

export function listExecutorEvents(db, instagramProfileId) {
  return db.prepare(`
    SELECT id, level, message, created_at AS createdAt
    FROM event_logs WHERE instagram_profile_id = ?
    ORDER BY id DESC LIMIT 40
  `).all(instagramProfileId);
}

export function getExecutorProfile(db, instagramProfileId) {
  const row = db.prepare(`
    SELECT instagram_profile_id AS instagramProfileId, webhook_url AS webhookUrl, secret, enabled,
      daily_limit AS dailyLimit, min_interval_minutes AS minIntervalMinutes,
      max_interval_minutes AS maxIntervalMinutes, schedule_start AS scheduleStart,
      schedule_end AS scheduleEnd, status, step, next_run_at AS nextRunAt,
      current_job_id AS currentJobId, consecutive_errors AS consecutiveErrors,
      last_error AS lastError, updated_at AS updatedAt
    FROM n8n_executor_settings WHERE instagram_profile_id = ?
  `).get(instagramProfileId);
  if (!row) return { ...DEFAULT_SETTINGS, instagramProfileId };
  return {
    ...DEFAULT_SETTINGS,
    ...row,
    enabled: Boolean(row.enabled),
    dailyLimit: Number(row.dailyLimit || DEFAULT_SETTINGS.dailyLimit),
    minIntervalMinutes: Number(row.minIntervalMinutes || DEFAULT_SETTINGS.minIntervalMinutes),
    maxIntervalMinutes: Number(row.maxIntervalMinutes || DEFAULT_SETTINGS.maxIntervalMinutes),
    sentToday: countSentToday(db, instagramProfileId),
    consecutiveErrors: Number(row.consecutiveErrors || 0),
    lastError: row.lastError || ''
  };
}

export function saveExecutorProfile(db, instagramProfileId, input) {
  if (!instagramProfileId) throw new Error('Instagram профиль не выбран');
  ensureExecutorProfile(db, instagramProfileId);
  const current = getExecutorProfile(db, instagramProfileId);
  const minInterval = clampInteger(input.minIntervalMinutes, current.minIntervalMinutes, 1, 240);
  const maxInterval = clampInteger(input.maxIntervalMinutes, current.maxIntervalMinutes, minInterval, 360);
  const settings = {
    webhookUrl: stringValue(input.webhookUrl, current.webhookUrl),
    secret: stringValue(input.secret, current.secret) || current.secret,
    dailyLimit: clampInteger(input.dailyLimit, current.dailyLimit, 1, 100),
    minIntervalMinutes: minInterval,
    maxIntervalMinutes: maxInterval,
    scheduleStart: normalizeTime(input.scheduleStart, current.scheduleStart),
    scheduleEnd: normalizeTime(input.scheduleEnd, current.scheduleEnd)
  };
  if (settings.webhookUrl && !/^https?:\/\//i.test(settings.webhookUrl)) throw new Error('Укажите корректный webhook URL');
  db.prepare(`
    UPDATE n8n_executor_settings
    SET webhook_url = ?, secret = ?, daily_limit = ?, min_interval_minutes = ?,
      max_interval_minutes = ?, schedule_start = ?, schedule_end = ?, updated_at = ?
    WHERE instagram_profile_id = ?
  `).run(settings.webhookUrl, settings.secret, settings.dailyLimit, settings.minIntervalMinutes,
    settings.maxIntervalMinutes, settings.scheduleStart, settings.scheduleEnd, nowIso(), instagramProfileId);
  return getExecutorProfile(db, instagramProfileId);
}

export function setExecutorEnabled(db, instagramProfileId, enabled, step = '') {
  ensureExecutorProfile(db, instagramProfileId);
  db.prepare(`
    UPDATE n8n_executor_settings
    SET enabled = ?, status = ?, step = ?, current_job_id = NULL,
      next_run_at = CASE WHEN ? = 1 THEN COALESCE(next_run_at, ?) ELSE NULL END,
      updated_at = ?
    WHERE instagram_profile_id = ?
  `).run(enabled ? 1 : 0, enabled ? 'waiting' : 'idle',
    step || (enabled ? 'Ждет следующего времени' : 'Остановлен'), enabled ? 1 : 0,
    nowIso(), nowIso(), instagramProfileId);
  return getExecutorProfile(db, instagramProfileId);
}

export function setExecutorRuntimeState(db, instagramProfileId, patch) {
  ensureExecutorProfile(db, instagramProfileId);
  const current = getExecutorProfile(db, instagramProfileId);
  const has = key => Object.prototype.hasOwnProperty.call(patch, key);
  db.prepare(`
    UPDATE n8n_executor_settings
    SET enabled = ?, status = ?, step = ?, next_run_at = ?, current_job_id = ?,
      consecutive_errors = ?, last_error = ?, updated_at = ?
    WHERE instagram_profile_id = ?
  `).run(has('enabled') ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
    has('status') ? patch.status : current.status,
    has('step') ? patch.step : current.step,
    has('nextRunAt') ? patch.nextRunAt : current.nextRunAt,
    has('currentJobId') ? patch.currentJobId : current.currentJobId,
    has('consecutiveErrors') ? patch.consecutiveErrors : current.consecutiveErrors,
    has('lastError') ? patch.lastError : current.lastError,
    nowIso(), instagramProfileId);
}

export function getEnabledExecutorProfiles(db) {
  return db.prepare('SELECT instagram_profile_id AS instagramProfileId FROM n8n_executor_settings WHERE enabled = 1').all();
}

export function upsertExecutorJob(db, instagramProfileId, task, status = 'running') {
  const jobId = stringValue(task.job_id ?? task.jobId);
  if (!jobId) throw new Error('n8n не вернул job_id');
  const username = normalizeUsername(task.target_username ?? task.username ?? task.instagram_username);
  const targetUrl = stringValue(task.target_url ?? task.profile_url ?? task.profileUrl) || (username ? `https://www.instagram.com/${username}/` : '');
  if (!username && !targetUrl) throw new Error('n8n не вернул получателя');
  const now = nowIso();
  db.prepare(`
    INSERT INTO n8n_executor_jobs
      (instagram_profile_id, job_id, target_username, target_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instagram_profile_id, job_id) DO UPDATE SET
      target_username = excluded.target_username, target_url = excluded.target_url,
      status = excluded.status, error = NULL, updated_at = excluded.updated_at
  `).run(instagramProfileId, jobId, username, targetUrl, status, now, now);
  return { jobId, targetUsername: username, targetUrl };
}

export function getExecutorJob(db, instagramProfileId, jobId) {
  return db.prepare('SELECT status, sent_at AS sentAt FROM n8n_executor_jobs WHERE instagram_profile_id = ? AND job_id = ?')
    .get(instagramProfileId, jobId);
}

export function finishExecutorJob(db, instagramProfileId, jobId, status, error = '') {
  const now = nowIso();
  db.prepare(`
    UPDATE n8n_executor_jobs
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
      updated_at = ?
    WHERE instagram_profile_id = ? AND job_id = ?
  `).run(status, error || null, status, now, now, instagramProfileId, jobId);
}

export function countSentToday(db, instagramProfileId) {
  const today = moscowDateKey(new Date());
  return db.prepare(`
    SELECT sent_at AS sentAt FROM n8n_executor_jobs
    WHERE instagram_profile_id = ? AND status = 'sent' AND sent_at IS NOT NULL
  `).all(instagramProfileId)
    .filter(row => row.sentAt ? moscowDateKey(new Date(row.sentAt)) === today : false).length;
}

export function buildExecutorPayload(db, instagramProfileId, event, extra = {}) {
  const identity = getAppIdentity(db);
  const account = db.prepare('SELECT username FROM accounts WHERE instagram_profile_id = ?').get(instagramProfileId);
  const settings = getExecutorProfile(db, instagramProfileId);
  return {
    event,
    workspace_id: identity.workspaceId,
    instagram_profile_id: instagramProfileId,
    app_profile_name: account?.username || '',
    secret: settings.secret,
    timestamp: nowIso(),
    ...extra
  };
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeTime(value, fallback) {
  const text = String(value || '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeUsername(value) {
  const text = stringValue(value).replace(/^@/, '').trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(text) ? text : '';
}

function moscowDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

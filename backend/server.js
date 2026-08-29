import http from 'node:http';
import { join } from 'node:path';
import { openInstagramLogin, detectInstagramAccount } from '../automation/instagramWorker.js';
import { runN8nExecutor } from '../automation/n8nExecutorWorker.js';
import { logEvent } from './events.js';
import {
  getEnabledExecutorProfiles,
  getExecutorProfile,
  listExecutorProfiles,
  saveExecutorProfile,
  setExecutorEnabled,
  setExecutorRuntimeState
} from './n8nExecutorStore.js';
import { buildLocalAccountDraft, deleteLocalAccount, getAccount, upsertAccount } from './profileStore.js';
import { initDatabase } from './storage.js';

const PORT = Number(process.env.PORT || 8732);
const appRoot = process.env.RASSILKA_APP_ROOT || process.cwd();
const db = initDatabase(join(appRoot, 'storage', 'agent.sqlite'));
const runningProfiles = new Set();
const controls = new Map();

function requestedProfileId(url, body = {}) {
  return String(body.instagramProfileId || body.instagram_profile_id || url.searchParams.get('instagramProfileId') || '').trim();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Некорректный JSON в запросе');
  }
}

function send(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  response.end(JSON.stringify(data));
}

async function route(request, response) {
  if (request.method === 'OPTIONS') return send(response, 200, { ok: true });
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, { ok: true, service: 'instagram-agent-backend' });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    return send(response, 200, { ok: true, service: 'instagram-agent-backend' });
  }

  if (request.method === 'GET' && url.pathname === '/n8n-executor/profiles') {
    return send(response, 200, { profiles: listExecutorProfiles(db) });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/settings') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const executor = saveExecutorProfile(db, instagramProfileId, body);
    logEvent(db, instagramProfileId, 'info', 'Настройки исполнителя сохранены');
    return send(response, 200, { ok: true, executor });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/start') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const settings = saveExecutorProfile(db, instagramProfileId, body);
    if (!settings.webhookUrl) return send(response, 400, { error: 'Укажите webhook URL' });
    setExecutorEnabled(db, instagramProfileId, true, 'Запуск исполнителя');
    setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
    logEvent(db, instagramProfileId, 'success', 'Исполнитель включен');
    startExecutor(instagramProfileId);
    return send(response, 200, { ok: true, executor: getExecutorProfile(db, instagramProfileId) });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/stop') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const control = controls.get(instagramProfileId);
    if (control) control.stop = true;
    const executor = setExecutorEnabled(db, instagramProfileId, false, 'Остановлен');
    logEvent(db, instagramProfileId, 'warning', 'Исполнитель выключен');
    return send(response, 200, { ok: true, executor });
  }

  if (request.method === 'POST' && url.pathname === '/accounts/create') {
    const account = buildLocalAccountDraft(db, appRoot);
    const connected = await openInstagramLogin(appRoot, account.profileDir);
    const savedAccount = upsertAccount(db, {
      ...account,
      username: connected.username || account.username,
      connected: connected.connected,
      profileDir: account.profileDir
    });
    logEvent(db, savedAccount.instagramProfileId, 'success', `Профиль @${savedAccount.username} подключен`);
    return send(response, 200, { ok: true, account: savedAccount });
  }

  if (request.method === 'POST' && url.pathname === '/account/connect') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const existing = getAccount(db, instagramProfileId);
    if (!existing) return send(response, 404, { error: 'Instagram профиль не найден' });
    const connected = await openInstagramLogin(appRoot, existing.profileDir);
    const account = upsertAccount(db, { ...existing, username: connected.username || existing.username, connected: true });
    logEvent(db, account.instagramProfileId, 'success', `Профиль @${account.username} переподключен`);
    return send(response, 200, {
      ok: true,
      account
    });
  }

  if (request.method === 'POST' && url.pathname === '/account/detect') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const existing = getAccount(db, instagramProfileId);
    if (!existing) return send(response, 404, { error: 'Instagram профиль не найден' });
    const detected = await detectInstagramAccount(appRoot, existing.profileDir, existing.username);
    return send(response, 200, {
      ok: true,
      account: upsertAccount(db, { ...existing, username: detected.username || existing.username, connected: detected.connected })
    });
  }

  if (request.method === 'POST' && url.pathname === '/accounts/delete') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    stopExecutor(instagramProfileId);
    const account = deleteLocalAccount(db, instagramProfileId);
    return send(response, 200, { ok: true, account });
  }

  return send(response, 404, { error: 'Маршрут не найден' });
}

http.createServer((request, response) => {
  route(request, response).catch(error => {
    console.error(error);
    send(response, 500, { error: error.message });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Instagram Agent API: http://127.0.0.1:${PORT}`);
  for (const profile of getEnabledExecutorProfiles(db)) startExecutor(profile.instagramProfileId);
});

function startExecutor(instagramProfileId) {
  if (!instagramProfileId || runningProfiles.has(instagramProfileId)) return;
  const control = { stop: false };
  runningProfiles.add(instagramProfileId);
  controls.set(instagramProfileId, control);
  runN8nExecutor(db, appRoot, instagramProfileId, control)
    .catch(error => {
      setExecutorRuntimeState(db, instagramProfileId, {
        status: 'paused',
        step: 'Исполнитель остановлен из-за ошибки',
        nextRunAt: null,
        currentJobId: null,
        lastError: error.message || String(error)
      });
      logEvent(db, instagramProfileId, 'error', error.message || String(error));
    })
    .finally(() => {
      runningProfiles.delete(instagramProfileId);
      controls.delete(instagramProfileId);
    });
}

function stopExecutor(instagramProfileId) {
  const control = controls.get(instagramProfileId);
  if (control) control.stop = true;
  if (instagramProfileId) setExecutorEnabled(db, instagramProfileId, false, 'Остановлен');
}

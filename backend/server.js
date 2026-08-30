import http from 'node:http';
import { join } from 'node:path';
import { checkChromeAvailable, openInstagramLogin, detectInstagramAccount } from '../automation/instagramWorker.js';
import { runN8nExecutor } from '../automation/n8nExecutorWorker.js';
import { assertAllowedOrigin, assertApiToken, corsHeaders, issueApiSession } from './apiSecurity.js';
import { logEvent } from './events.js';
import {
  getEnabledExecutorProfiles,
  getExecutorProfile,
  hasAccount,
  listExecutorProfiles,
  publicExecutorProfile,
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
const runs = new Map();

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

function send(request, response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(request)
  });
  response.end(JSON.stringify(data));
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'OPTIONS') {
    assertAllowedOrigin(request);
    return send(request, response, 200, { ok: true });
  }
  assertApiToken(db, request, url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return send(request, response, 200, { ok: true, service: 'instagram-agent-backend' });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    return send(request, response, 200, { ok: true, service: 'instagram-agent-backend' });
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    return send(request, response, 200, issueApiSession(db, request));
  }

  if (request.method === 'GET' && url.pathname === '/preflight') {
    return send(request, response, 200, { chrome: await checkChromeAvailable() });
  }

  if (request.method === 'GET' && url.pathname === '/n8n-executor/profiles') {
    return send(request, response, 200, { profiles: listExecutorProfiles(db) });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/settings') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const executor = saveExecutorProfile(db, instagramProfileId, body);
    logEvent(db, instagramProfileId, 'info', 'Настройки исполнителя сохранены');
    return send(request, response, 200, { ok: true, executor: publicExecutorProfile(executor) });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/start') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const settings = saveExecutorProfile(db, instagramProfileId, body);
    const chrome = await checkChromeAvailable();
    if (!chrome.ok) return send(request, response, 400, { error: chrome.message });
    if (!settings.webhookUrl) return send(request, response, 400, { error: 'Укажите webhook URL' });
    setExecutorEnabled(db, instagramProfileId, true, 'Запуск исполнителя');
    setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
    logEvent(db, instagramProfileId, 'success', 'Исполнитель включен');
    startExecutor(instagramProfileId);
    return send(request, response, 200, { ok: true, executor: publicExecutorProfile(getExecutorProfile(db, instagramProfileId)) });
  }

  if (request.method === 'POST' && url.pathname === '/n8n-executor/stop') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const control = controls.get(instagramProfileId);
    if (control) stopControl(control);
    const executor = setExecutorEnabled(db, instagramProfileId, false, 'Остановлен');
    logEvent(db, instagramProfileId, 'warning', 'Исполнитель выключен');
    return send(request, response, 200, { ok: true, executor: publicExecutorProfile(executor) });
  }

  if (request.method === 'POST' && url.pathname === '/accounts/create') {
    const chrome = await checkChromeAvailable();
    if (!chrome.ok) return send(request, response, 400, { error: chrome.message });
    const account = buildLocalAccountDraft(db, appRoot);
    const connected = await openInstagramLogin(appRoot, account.profileDir);
    const savedAccount = upsertAccount(db, {
      ...account,
      username: connected.username || account.username,
      connected: connected.connected,
      profileDir: account.profileDir
    });
    logEvent(db, savedAccount.instagramProfileId, 'success', `Профиль @${savedAccount.username} подключен`);
    return send(request, response, 200, { ok: true, account: savedAccount });
  }

  if (request.method === 'POST' && url.pathname === '/account/connect') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const existing = getAccount(db, instagramProfileId);
    if (!existing) return send(request, response, 404, { error: 'Instagram профиль не найден' });
    const chrome = await checkChromeAvailable();
    if (!chrome.ok) return send(request, response, 400, { error: chrome.message });
    const connected = await openInstagramLogin(appRoot, existing.profileDir);
    const previousUsername = normalizeUsername(existing.username);
    const nextUsername = normalizeUsername(connected.username);
    if (previousUsername && nextUsername && previousUsername !== nextUsername) {
      throw new Error(`В этом профиле был @${previousUsername}, а сейчас открыт @${nextUsername}. Создайте новый профиль для другого аккаунта.`);
    }
    const account = upsertAccount(db, { ...existing, username: connected.username || existing.username, connected: true });
    logEvent(db, account.instagramProfileId, 'success', `Профиль @${account.username} переподключен`);
    return send(request, response, 200, {
      ok: true,
      account
    });
  }

  if (request.method === 'POST' && url.pathname === '/account/detect') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const existing = getAccount(db, instagramProfileId);
    if (!existing) return send(request, response, 404, { error: 'Instagram профиль не найден' });
    const detected = await detectInstagramAccount(appRoot, existing.profileDir, existing.username);
    return send(request, response, 200, {
      ok: true,
      account: upsertAccount(db, { ...existing, username: detected.username || existing.username, connected: detected.connected })
    });
  }

  if (request.method === 'POST' && url.pathname === '/accounts/delete') {
    const body = await readBody(request);
    const instagramProfileId = requestedProfileId(url, body);
    const stopped = await stopExecutor(instagramProfileId);
    if (!stopped) return send(request, response, 409, { error: 'Профиль еще завершает текущую операцию. Повторите удаление через несколько секунд.' });
    const account = deleteLocalAccount(db, instagramProfileId);
    return send(request, response, 200, { ok: true, account });
  }

  return send(request, response, 404, { error: 'Маршрут не найден' });
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    console.error(error);
    send(request, response, error.statusCode || 500, { error: error.message });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Instagram Agent API: http://127.0.0.1:${PORT}`);
  for (const profile of getEnabledExecutorProfiles(db)) startExecutor(profile.instagramProfileId);
});

function startExecutor(instagramProfileId) {
  if (!instagramProfileId || runningProfiles.has(instagramProfileId)) return;
  const control = { stop: false, abortController: new AbortController() };
  runningProfiles.add(instagramProfileId);
  controls.set(instagramProfileId, control);
  const run = runN8nExecutor(db, appRoot, instagramProfileId, control)
    .catch(error => {
      if (!hasAccount(db, instagramProfileId)) return;
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
      runs.delete(instagramProfileId);
    });
  runs.set(instagramProfileId, run);
}

async function stopExecutor(instagramProfileId) {
  const control = controls.get(instagramProfileId);
  if (control) stopControl(control);
  if (instagramProfileId) setExecutorEnabled(db, instagramProfileId, false, 'Остановлен');
  const run = runs.get(instagramProfileId);
  if (!run) return true;
  return await Promise.race([
    run.then(() => true).catch(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 15_000))
  ]);
}

function stopControl(control) {
  control.stop = true;
  control.abortController?.abort();
  control.activeContext?.close().catch(() => {});
}

function normalizeUsername(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

async function shutdown() {
  for (const control of controls.values()) stopControl(control);
  await Promise.race([
    Promise.all([...runs.values()].map(run => run.catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, 10_000))
  ]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

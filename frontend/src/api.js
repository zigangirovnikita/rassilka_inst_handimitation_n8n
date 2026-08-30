const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8732';
let apiToken = import.meta.env.VITE_API_TOKEN || '';

async function ensureSession() {
  if (apiToken) return apiToken;
  const response = await fetch(`${API_URL}/api/session`);
  const body = await response.json();
  apiToken = body.token || '';
  if (!apiToken) throw new Error('Локальная авторизация не получена');
  return apiToken;
}

async function request(path, options = {}) {
  const token = await ensureSession();
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Instagram-Agent-Token': token,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `Ошибка ${response.status}`);
  return body;
}

export function listProfiles() {
  return request('/n8n-executor/profiles');
}

export function getPreflight() {
  return request('/preflight');
}

export function saveExecutorSettings(instagramProfileId, settings) {
  return request('/n8n-executor/settings', {
    method: 'POST',
    body: JSON.stringify({ instagramProfileId, ...settings })
  });
}

export function startExecutor(instagramProfileId, settings) {
  return request('/n8n-executor/start', {
    method: 'POST',
    body: JSON.stringify({ instagramProfileId, ...settings })
  });
}

export function stopExecutor(instagramProfileId) {
  return request('/n8n-executor/stop', {
    method: 'POST',
    body: JSON.stringify({ instagramProfileId })
  });
}

export function createAccount() {
  return request('/accounts/create', { method: 'POST', body: '{}' });
}

export function reconnectAccount(instagramProfileId) {
  return request('/account/connect', {
    method: 'POST',
    body: JSON.stringify({ instagramProfileId })
  });
}

export function deleteAccount(instagramProfileId) {
  return request('/accounts/delete', {
    method: 'POST',
    body: JSON.stringify({ instagramProfileId })
  });
}

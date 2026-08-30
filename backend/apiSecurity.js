import { getAppIdentity } from './identity.js';

const DEV_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174'
]);

export function corsHeaders(request) {
  const origin = request.headers.origin || '';
  const allowedOrigin = isAllowedOrigin(origin) ? origin : '';
  return {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, X-Instagram-Agent-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true'
  };
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  if (origin === 'tauri.localhost') return true;
  if (DEV_ORIGINS.has(origin)) return true;
  return /^(https?|tauri):\/\/(tauri\.localhost|localhost)(?::\d+)?$/i.test(origin);
}

export function assertAllowedOrigin(request) {
  if (!isAllowedOrigin(request.headers.origin || '')) {
    const error = new Error('Недоверенный источник запроса');
    error.statusCode = 403;
    throw error;
  }
}

export function issueApiSession(db, request) {
  assertAllowedOrigin(request);
  return { token: getAppIdentity(db).apiToken };
}

export function assertApiToken(db, request, url) {
  if (request.method === 'OPTIONS') return;
  if (isPublicPath(url.pathname)) return;
  assertAllowedOrigin(request);
  const token = request.headers['x-instagram-agent-token'] || '';
  if (!token || token !== getAppIdentity(db).apiToken) {
    const error = new Error('Локальная авторизация не пройдена');
    error.statusCode = 401;
    throw error;
  }
}

function isPublicPath(pathname) {
  return pathname === '/health' || pathname === '/' || pathname === '/api/session';
}

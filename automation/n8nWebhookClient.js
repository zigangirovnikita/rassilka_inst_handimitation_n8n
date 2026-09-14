import { ExecutorJobError, assertNotStopped } from './executorErrors.js';

export const N8N_TIMEOUT_MS = 3 * 60_000;

export async function postJson(url, payload, timeoutMs = N8N_TIMEOUT_MS, control = {}) {
  assertNotStopped(control);
  const controller = new AbortController();
  const abort = () => controller.abort();
  control.abortController?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    const body = parseJson(text) || { text };
    if (!response.ok) throw new Error(body.error || body.message || `webhook вернул HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (control.stop) throw new ExecutorJobError('stopped', 'Исполнитель остановлен', 'system');
    if (error.name === 'AbortError') throw new ExecutorJobError('n8n_timeout', 'webhook не ответил за 3 минуты', 'lead');
    throw error;
  } finally {
    clearTimeout(timer);
    control.abortController?.signal?.removeEventListener('abort', abort);
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

import { logEvent } from '../backend/events.js';
import {
  buildExecutorPayload,
  countSentToday,
  finishExecutorJob,
  getRecentRecipientJob,
  getExecutorJob,
  getExecutorProfile,
  hasAccount,
  setExecutorRuntimeState,
  upsertExecutorJob
} from '../backend/n8nExecutorStore.js';
import { ACCOUNT_FAILURE_REASONS, ExecutorJobError, assertNotStopped, classifyError, isLeadFailure } from './executorErrors.js';
import { isMessageButtonLabel, openProfileAndCapture, sendInstagramMessage } from './instagramPageActions.js';
import { openChromeContext } from './instagramWorker.js';
import { classifyNextTaskResponse, completionMessage } from './n8nExecutorResponse.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_CONSECUTIVE_ERRORS = 3;
const N8N_TIMEOUT_MS = 3 * 60_000;
export { isMessageButtonLabel };

export async function runN8nExecutor(db, appRoot, instagramProfileId, control = {}) {
  const account = db.prepare(`
    SELECT connected, profile_dir AS profileDir, username
    FROM accounts WHERE instagram_profile_id = ?
  `).get(instagramProfileId);
  if (!account?.connected) throw new Error('Сначала подключите Instagram аккаунт');

  while (!control.stop) {
    const settings = getExecutorProfile(db, instagramProfileId);
    if (!settings.enabled) break;
    if (!settings.webhookUrl) {
      setExecutorRuntimeState(db, instagramProfileId, { enabled: false, status: 'paused', step: 'Укажите webhook', nextRunAt: null, currentJobId: null });
      break;
    }
    if (!isInsideMoscowSchedule(settings.scheduleStart, settings.scheduleEnd)) {
      await waitUntilNextCheck(db, instagramProfileId, control, 60_000, 'Вне рабочего времени');
      continue;
    }
    if (countSentToday(db, instagramProfileId) >= settings.dailyLimit) {
      await waitUntilNextCheck(db, instagramProfileId, control, 15 * 60_000, 'Дневной лимит исчерпан');
      continue;
    }

    try {
      const taskResult = await requestNextTask(db, instagramProfileId, settings, control);
      if (taskResult?.completed) {
        completeExecutor(db, instagramProfileId, taskResult.message);
        break;
      }
      if (!taskResult?.task) {
        setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
        await waitUntilNextCheck(db, instagramProfileId, control, 60_000, 'Задач пока нет');
        continue;
      }
      await processTask(db, appRoot, instagramProfileId, settings, taskResult.task, control);
      setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
      if (!control.stop) await waitUntilNextMessage(db, instagramProfileId, control, settings);
    } catch (error) {
      if (!hasAccount(db, instagramProfileId)) break;
      const current = getExecutorProfile(db, instagramProfileId);
      const consecutiveErrors = current.consecutiveErrors + 1;
      const message = error.message || String(error);
      const reason = classifyError(error);
      if (ACCOUNT_FAILURE_REASONS.has(reason)) {
        setExecutorRuntimeState(db, instagramProfileId, {
          enabled: false,
          status: 'paused',
          step: 'Аккаунт требует проверки',
          nextRunAt: null,
          currentJobId: null,
          consecutiveErrors,
          lastError: message
        });
        if (!error.executorEventLogged) logEvent(db, instagramProfileId, 'error', `Исполнитель: ${message}`);
        break;
      }
      setExecutorRuntimeState(db, instagramProfileId, {
        enabled: consecutiveErrors < MAX_CONSECUTIVE_ERRORS,
        status: consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ? 'paused' : 'waiting',
        step: consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ? 'Пауза после нескольких ошибок' : 'Ошибка, повтор позже',
        nextRunAt: consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ? null : new Date(Date.now() + 5 * 60_000).toISOString(),
        currentJobId: null,
        consecutiveErrors,
        lastError: message
      });
      if (!error.executorEventLogged) logEvent(db, instagramProfileId, 'error', `Исполнитель: ${message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
      await sleepInterruptibly(5 * 60_000, control);
    }
  }

  if (!hasAccount(db, instagramProfileId)) return;
  const final = getExecutorProfile(db, instagramProfileId);
  if (control.stop || final.enabled) {
    setExecutorRuntimeState(db, instagramProfileId, {
      status: control.stop ? 'idle' : final.status,
      step: control.stop ? 'Остановлен' : final.step,
      nextRunAt: control.stop ? null : final.nextRunAt,
      currentJobId: null
    });
  }
}

async function requestNextTask(db, instagramProfileId, settings, control) {
  assertNotStopped(control);
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'running',
    step: 'Запрашивает следующую задачу',
    currentJobId: null
  });
  const payload = buildExecutorPayload(db, instagramProfileId, 'next_task', {
    sent_today: countSentToday(db, instagramProfileId),
    daily_limit: settings.dailyLimit
  });
  const response = await postJson(settings.webhookUrl, payload, N8N_TIMEOUT_MS, control);
  const responseType = classifyNextTaskResponse(response);
  if (responseType === 'completed') return { completed: true, message: completionMessage(response) };
  if (responseType === 'waiting') return { task: null };
  const task = response.task || response.job || response;
  const jobId = task.job_id || task.jobId;
  if (!jobId) return { task: null };
  const username = normalizeUsername(task.target_username ?? task.username ?? task.instagram_username);
  if (!username) throw new ExecutorJobError('message_text_empty', 'n8n не вернул корректный username получателя', 'lead');
  const existing = getExecutorJob(db, instagramProfileId, jobId);
  if (['sent', 'sending', 'uncertain'].includes(existing?.status)) {
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'duplicate_job', {
      job_id: jobId,
      target_username: existing.targetUsername || username,
      status: existing.status
    }), N8N_TIMEOUT_MS, control).catch(() => {});
    return { task: null };
  }
  const recentRecipient = getRecentRecipientJob(db, instagramProfileId, username);
  if (recentRecipient && recentRecipient.jobId !== jobId) {
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'duplicate_recipient', {
      job_id: jobId,
      existing_job_id: recentRecipient.jobId,
      target_username: username,
      status: recentRecipient.status
    }), N8N_TIMEOUT_MS, control).catch(() => {});
    return { task: null };
  }
  return { task };
}

function completeExecutor(db, instagramProfileId, message = 'Рассылка завершена') {
  setExecutorRuntimeState(db, instagramProfileId, {
    enabled: false,
    status: 'completed',
    step: message,
    nextRunAt: null,
    currentJobId: null,
    consecutiveErrors: 0,
    lastError: ''
  });
  logEvent(db, instagramProfileId, 'success', message);
}

async function processTask(db, appRoot, instagramProfileId, settings, task, control) {
  assertNotStopped(control);
  const job = upsertExecutorJob(db, instagramProfileId, task, 'running');
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'running',
    step: `Открывает @${job.targetUsername || 'профиль'}`,
    currentJobId: job.jobId
  });

  const account = db.prepare('SELECT profile_dir AS profileDir FROM accounts WHERE instagram_profile_id = ?').get(instagramProfileId);
  let context = null;
  try {
    context = await openChromeContext(appRoot, account.profileDir, { interactive: false });
    control.activeContext = context;
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15_000);
    const profile = await openProfileAndCapture(page, job);
    const messageResponse = await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'profile_opened', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      screenshot_base64: profile.screenshotBase64,
      screenshot_mime: 'image/png',
      result: profile.result
    }), N8N_TIMEOUT_MS, control);
    if (!profile.result.can_message) throw new ExecutorJobError('no_message_button', 'Кнопка сообщения недоступна', 'lead');
    const messageText = extractMessageText(messageResponse);
    if (!messageText) throw new ExecutorJobError('message_text_empty', 'n8n не вернул текст сообщения', 'lead');

    assertNotStopped(control);
    setExecutorRuntimeState(db, instagramProfileId, {
      status: 'running',
      step: `Отправляет @${job.targetUsername || 'сообщение'}`,
      currentJobId: job.jobId
    });
    finishExecutorJob(db, instagramProfileId, job.jobId, 'sending');
    await sendInstagramMessage(page, messageText);
    finishExecutorJob(db, instagramProfileId, job.jobId, 'sent');
    logEvent(db, instagramProfileId, 'success', `Сообщение для @${job.targetUsername} отправлено`);
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'sent', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl
    }), N8N_TIMEOUT_MS, control).catch(error => {
      logEvent(db, instagramProfileId, 'warning', `Сообщение для @${job.targetUsername} отправлено, но отчет не дошел`);
      console.warn('Failed to report sent status to n8n:', error.message || error);
    });
  } catch (error) {
    const reason = error.reason || classifyError(error);
    if (reason === 'stopped') return { stopped: true };
    if (getExecutorJob(db, instagramProfileId, job.jobId)?.status === 'sending' && !error.instagramSendRejected) {
      finishExecutorJob(db, instagramProfileId, job.jobId, 'uncertain', reason);
    } else {
      finishExecutorJob(db, instagramProfileId, job.jobId, 'failed', reason);
    }
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'failed', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      reason,
      error: error.message || String(error)
    }), N8N_TIMEOUT_MS, control).catch(() => {});
    logEvent(db, instagramProfileId, 'error', `Сообщение для @${job.targetUsername || 'профиля'} - ошибка: ${error.message || String(error)}`);
    error.executorEventLogged = true;
    if (isLeadFailure(reason)) return { failed: true };
    throw error;
  } finally {
    if (control.activeContext === context) control.activeContext = null;
    if (context) await context.close().catch(() => {});
  }
}

function extractMessageText(response) {
  return String(response?.message_text || response?.messageText || response?.message?.text || response?.text || '').trim();
}

async function waitUntilNextMessage(db, instagramProfileId, control, settings) {
  const delay = randomIntervalMs(settings.minIntervalMinutes, settings.maxIntervalMinutes);
  await waitUntilNextCheck(db, instagramProfileId, control, delay, 'Ждет следующего сообщения');
}

async function waitUntilNextCheck(db, instagramProfileId, control, delay, step) {
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'waiting',
    step,
    nextRunAt: new Date(Date.now() + delay).toISOString(),
    currentJobId: null
  });
  await sleepInterruptibly(delay, control);
}

async function sleepInterruptibly(milliseconds, control) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (control.stop) return;
    await sleep(Math.min(1000, until - Date.now()));
  }
}

async function postJson(url, payload, timeoutMs = N8N_TIMEOUT_MS, control = {}) {
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

function randomIntervalMs(minMinutes, maxMinutes) {
  const low = Math.max(1, Number(minMinutes) || 1);
  const high = Math.max(low, Number(maxMinutes) || low);
  return Math.round((low + Math.random() * (high - low)) * 60_000);
}

function isInsideMoscowSchedule(start, end) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const current = Number(parts.find(part => part.type === 'hour')?.value || 0) * 60
    + Number(parts.find(part => part.type === 'minute')?.value || 0);
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes <= endMinutes) return current >= startMinutes && current <= endMinutes;
  return current >= startMinutes || current <= endMinutes;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function normalizeUsername(value) {
  return String(value || '').replace(/^@/, '').trim();
}

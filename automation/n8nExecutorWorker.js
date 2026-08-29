import { logEvent } from '../backend/events.js';
import {
  buildExecutorPayload,
  countSentToday,
  finishExecutorJob,
  getExecutorJob,
  getExecutorProfile,
  setExecutorRuntimeState,
  upsertExecutorJob
} from '../backend/n8nExecutorStore.js';
import { openChromeContext } from './instagramWorker.js';
import { classifyNextTaskResponse, completionMessage } from './n8nExecutorResponse.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_CONSECUTIVE_ERRORS = 3;
const N8N_TIMEOUT_MS = 3 * 60_000;
const MESSAGE_BUTTON_PATTERN = /^(message|send message|сообщение|отправить сообщение|написать)$/i;

export function isMessageButtonLabel(label) {
  return MESSAGE_BUTTON_PATTERN.test(String(label || '').trim());
}

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
      const taskResult = await requestNextTask(db, instagramProfileId, settings);
      if (taskResult?.completed) {
        completeExecutor(db, instagramProfileId, taskResult.message);
        break;
      }
      if (!taskResult?.task) {
        setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
        await waitUntilNextCheck(db, instagramProfileId, control, 60_000, 'Задач пока нет');
        continue;
      }
      await processTask(db, appRoot, instagramProfileId, settings, taskResult.task);
      setExecutorRuntimeState(db, instagramProfileId, { consecutiveErrors: 0, lastError: '' });
      if (!control.stop) await waitUntilNextMessage(db, instagramProfileId, control, settings);
    } catch (error) {
      const current = getExecutorProfile(db, instagramProfileId);
      const consecutiveErrors = current.consecutiveErrors + 1;
      const message = error.message || String(error);
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

async function requestNextTask(db, instagramProfileId, settings) {
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'running',
    step: 'Запрашивает следующую задачу',
    currentJobId: null
  });
  const payload = buildExecutorPayload(db, instagramProfileId, 'next_task', {
    sent_today: countSentToday(db, instagramProfileId),
    daily_limit: settings.dailyLimit
  });
  const response = await postJson(settings.webhookUrl, payload, N8N_TIMEOUT_MS);
  const responseType = classifyNextTaskResponse(response);
  if (responseType === 'completed') return { completed: true, message: completionMessage(response) };
  if (responseType === 'waiting') return { task: null };
  const task = response.task || response.job || response;
  const jobId = task.job_id || task.jobId;
  if (!jobId) return { task: null };
  const existing = getExecutorJob(db, instagramProfileId, jobId);
  if (existing?.status === 'sent') {
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'duplicate_job', { job_id: jobId }), N8N_TIMEOUT_MS);
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

async function processTask(db, appRoot, instagramProfileId, settings, task) {
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
    const page = context.pages()[0] || await context.newPage();
    const profile = await openProfileAndCapture(page, job);
    const messageResponse = await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'profile_opened', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      screenshot_base64: profile.screenshotBase64,
      screenshot_mime: 'image/png',
      result: profile.result
    }), N8N_TIMEOUT_MS);
    if (!profile.result.can_message) throw new ExecutorJobError('no_message_button', 'Кнопка сообщения недоступна');
    const messageText = extractMessageText(messageResponse);
    if (!messageText) throw new ExecutorJobError('message_text_empty', 'n8n не вернул текст сообщения');

    setExecutorRuntimeState(db, instagramProfileId, {
      status: 'running',
      step: `Отправляет @${job.targetUsername || 'сообщение'}`,
      currentJobId: job.jobId
    });
    await sendInstagramMessage(page, messageText);
    finishExecutorJob(db, instagramProfileId, job.jobId, 'sent');
    logEvent(db, instagramProfileId, 'success', `Сообщение для @${job.targetUsername} отправлено`);
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'sent', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl
    }), N8N_TIMEOUT_MS).catch(error => {
      logEvent(db, instagramProfileId, 'warning', `Сообщение для @${job.targetUsername} отправлено, но отчет не дошел`);
      console.warn('Failed to report sent status to n8n:', error.message || error);
    });
  } catch (error) {
    const reason = error.reason || classifyError(error);
    finishExecutorJob(db, instagramProfileId, job.jobId, 'failed', reason);
    await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'failed', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      reason,
      error: error.message || String(error)
    }), N8N_TIMEOUT_MS).catch(() => {});
    logEvent(db, instagramProfileId, 'error', `Сообщение для @${job.targetUsername || 'профиля'} - ошибка: ${error.message || String(error)}`);
    error.executorEventLogged = true;
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function openProfileAndCapture(page, job) {
  await page.goto(job.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/log in|sign up|войдите|зарегистрируйтесь/i.test(bodyText)) {
    throw new ExecutorJobError('login_required', 'Instagram просит повторно войти в аккаунт');
  }
  if (/sorry, this page isn't available|страница недоступна/i.test(bodyText)) {
    throw new ExecutorJobError('profile_unavailable', 'Профиль недоступен');
  }
  await clickMoreDescription(page);
  await page.waitForTimeout(700);
  const screenshot = await page.screenshot({ type: 'png', fullPage: false });
  return {
    screenshotBase64: screenshot.toString('base64'),
    result: {
      can_message: await hasMessageButton(page),
      is_private: /this account is private|это закрытый аккаунт/i.test(bodyText),
      page_url: page.url()
    }
  };
}

async function clickMoreDescription(page) {
  const more = page.getByText(/^(more|ещ[её])$/i).first();
  if (await more.count()) {
    await more.click({ timeout: 3000 }).catch(() => {});
    return;
  }
  const button = page.getByRole('button', { name: /^(more|ещ[её])$/i }).first();
  if (await button.count()) await button.click({ timeout: 3000 }).catch(() => {});
}

async function sendInstagramMessage(page, messageText) {
  const messageButton = messageButtonLocator(page);
  if (!(await messageButton.count())) throw new ExecutorJobError('no_message_button', 'Кнопка сообщения недоступна');
  await messageButton.click({ timeout: 15_000 });
  const textbox = await waitForMessageTextbox(page);
  await textbox.click({ timeout: 10_000 }).catch(() => {});
  await textbox.fill(messageText, { timeout: 10_000 });
  const sendButton = page.getByRole('button', { name: /^(send|отправить)$/i }).last();
  if (await sendButton.count()) await sendButton.click({ timeout: 10_000 });
  else await page.keyboard.press('Enter');
  await confirmInstagramSend(page, textbox);
}

async function hasMessageButton(page) {
  return await messageButtonLocator(page).count() > 0;
}

function messageButtonLocator(page) {
  return page.getByRole('button', { name: MESSAGE_BUTTON_PATTERN }).first();
}

async function waitForMessageTextbox(page) {
  const textbox = page.getByRole('textbox').last();
  await textbox.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {
      throw new ExecutorJobError('message_box_missing', 'Поле ввода сообщения недоступно');
    });
  return textbox;
}

async function confirmInstagramSend(page, textbox) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isComposerCleared(textbox)) return;
    await page.waitForTimeout(500);
  }
  throw new ExecutorJobError('send_confirmation_missing', 'Instagram не подтвердил отправку сообщения');
}

async function isComposerCleared(textbox) {
  const text = await textbox.innerText({ timeout: 1000 }).catch(() => '');
  const value = await textbox.inputValue({ timeout: 1000 }).catch(() => '');
  return !normalizeMessageText(text || value);
}

export function normalizeMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
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

async function postJson(url, payload, timeoutMs = N8N_TIMEOUT_MS) {
  const controller = new AbortController();
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
    if (error.name === 'AbortError') throw new ExecutorJobError('n8n_timeout', 'webhook не ответил за 3 минуты');
    throw error;
  } finally {
    clearTimeout(timer);
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

function classifyError(error) {
  const message = String(error?.message || error || '');
  if (/log in|войти/i.test(message)) return 'login_required';
  if (/3 минуты|timeout|abort/i.test(message)) return 'n8n_timeout';
  if (/кнопка сообщения|message/i.test(message)) return 'no_message_button';
  if (/недоступ/i.test(message)) return 'profile_unavailable';
  return 'browser_error';
}

class ExecutorJobError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

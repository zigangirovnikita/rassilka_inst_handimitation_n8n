import { logEvent } from '../backend/events.js';
import {
  buildExecutorPayload,
  countCommentsSentToday,
  countSentToday,
  finishCommentJob,
  getCommentJob,
  setExecutorRuntimeState,
  upsertCommentJob
} from '../backend/n8nExecutorStore.js';
import { ExecutorJobError, assertNotStopped, classifyError, isLeadFailure } from './executorErrors.js';
import { openCommentPublication, sendInstagramComment } from './instagramCommentActions.js';
import { openChromeContext } from './instagramWorker.js';
import { classifyNextTaskResponse, completionMessage } from './n8nExecutorResponse.js';
import { N8N_TIMEOUT_MS, postJson } from './n8nWebhookClient.js';

export async function requestNextComment(db, instagramProfileId, settings, control) {
  assertNotStopped(control);
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'running',
    step: 'Запрашивает следующий комментарий',
    currentJobId: null
  });
  const response = await postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, 'next_comment', {
    messages_sent_today: countSentToday(db, instagramProfileId),
    comments_sent_today: countCommentsSentToday(db, instagramProfileId),
    daily_limit: settings.dailyLimit
  }), N8N_TIMEOUT_MS, control);
  const responseType = classifyNextTaskResponse(response);
  if (responseType === 'completed') {
    return { completed: true, message: completionMessage(response) || 'Рассылка сообщений и комментариев завершена' };
  }
  if (responseType === 'waiting') return { task: null };

  const task = response.task || response.job || response;
  const jobId = task.job_id || task.jobId;
  const username = normalizeUsername(task.target_username ?? task.username ?? task.instagram_username);
  const commentText = extractCommentText(task);
  if (!jobId || !username || !commentText) {
    throw new ExecutorJobError('comment_text_empty', 'n8n не вернул полное задание для комментария', 'lead');
  }

  const existing = getCommentJob(db, instagramProfileId, jobId);
  if (existing?.status === 'sent') {
    await reportCommentStatus(db, instagramProfileId, settings, control, 'comment_sent', {
      job_id: jobId,
      target_username: existing.targetUsername || username,
      target_url: existing.targetUrl || `https://www.instagram.com/${username}/`,
      post_url: existing.postUrl || '',
      recovered_duplicate: true
    }).catch(() => {});
    return { task: null };
  }
  if (['commenting', 'uncertain'].includes(existing?.status)) {
    if (existing.status === 'commenting') {
      finishCommentJob(db, instagramProfileId, jobId, 'uncertain', 'comment_uncertain', existing.postUrl || '');
    }
    await reportCommentStatus(db, instagramProfileId, settings, control, 'comment_failed', {
      job_id: jobId,
      target_username: existing.targetUsername || username,
      target_url: existing.targetUrl || `https://www.instagram.com/${username}/`,
      post_url: existing.postUrl || '',
      reason: 'comment_uncertain',
      error: 'Результат предыдущей отправки требует ручной проверки'
    }).catch(() => {});
    return { task: null };
  }
  return { task };
}

export async function processCommentTask(db, appRoot, instagramProfileId, settings, task, control) {
  assertNotStopped(control);
  const job = upsertCommentJob(db, instagramProfileId, task, 'running');
  setExecutorRuntimeState(db, instagramProfileId, {
    status: 'running',
    step: `Открывает профиль @${job.targetUsername}`,
    currentJobId: job.jobId
  });

  const account = db.prepare('SELECT profile_dir AS profileDir FROM accounts WHERE instagram_profile_id = ?').get(instagramProfileId);
  let context = null;
  let postUrl = '';
  let selection = '';
  try {
    context = await openChromeContext(appRoot, account.profileDir, { interactive: false });
    control.activeContext = context;
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15_000);
    const publication = await openCommentPublication(page, job);
    postUrl = publication.postUrl;
    selection = publication.selection;

    assertNotStopped(control);
    setExecutorRuntimeState(db, instagramProfileId, {
      status: 'running',
      step: `Комментирует публикацию @${job.targetUsername}`,
      currentJobId: job.jobId
    });
    finishCommentJob(db, instagramProfileId, job.jobId, 'commenting', '', postUrl);
    await sendInstagramComment(page, job.commentText);
    finishCommentJob(db, instagramProfileId, job.jobId, 'sent', '', postUrl);
    logEvent(db, instagramProfileId, 'success', `Комментарий для @${job.targetUsername} отправлен`);
    await reportCommentStatus(db, instagramProfileId, settings, control, 'comment_sent', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      post_url: postUrl,
      publication_selection: selection
    }).catch(error => {
      logEvent(db, instagramProfileId, 'warning', `Комментарий для @${job.targetUsername} отправлен, но отчет не дошел`);
      console.warn('Failed to report comment status to n8n:', error.message || error);
    });
  } catch (error) {
    const currentStatus = getCommentJob(db, instagramProfileId, job.jobId)?.status;
    if (control.stop || error.reason === 'stopped') {
      if (currentStatus === 'commenting') finishCommentJob(db, instagramProfileId, job.jobId, 'uncertain', 'stopped', postUrl);
      return { stopped: true };
    }
    const reason = error.reason || classifyError(error);
    const uncertain = currentStatus === 'commenting' && !error.instagramSendRejected;
    finishCommentJob(db, instagramProfileId, job.jobId, uncertain ? 'uncertain' : 'failed', reason, postUrl);
    await reportCommentStatus(db, instagramProfileId, settings, control, 'comment_failed', {
      job_id: job.jobId,
      target_username: job.targetUsername,
      target_url: job.targetUrl,
      post_url: postUrl,
      publication_selection: selection,
      reason: uncertain ? 'comment_uncertain' : reason,
      error: error.message || String(error)
    }).catch(() => {});
    logEvent(db, instagramProfileId, 'error', `Комментарий для @${job.targetUsername} - ошибка: ${error.message || String(error)}`);
    error.executorEventLogged = true;
    if (isLeadFailure(reason)) return { failed: true };
    throw error;
  } finally {
    if (control.activeContext === context) control.activeContext = null;
    if (context) await context.close().catch(() => {});
  }
}

function extractCommentText(response) {
  return String(response?.comment_text || response?.commentText || response?.message_text || response?.messageText || '').trim();
}

function reportCommentStatus(db, instagramProfileId, settings, control, event, extra) {
  return postJson(settings.webhookUrl, buildExecutorPayload(db, instagramProfileId, event, extra), N8N_TIMEOUT_MS, control);
}

function normalizeUsername(value) {
  return String(value || '').replace(/^@/, '').trim();
}

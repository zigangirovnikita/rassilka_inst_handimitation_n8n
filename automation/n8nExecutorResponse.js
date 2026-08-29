export function classifyNextTaskResponse(response) {
  if (isCompletedResponse(response)) return 'completed';
  if (isNoTaskResponse(response)) return isTemporaryNoTaskResponse(response) ? 'waiting' : 'completed';
  const task = response?.task || response?.job || response || {};
  return (task.job_id || task.jobId) ? 'task' : 'waiting';
}

export function completionMessage(response) {
  return String(response?.message || response?.step || response?.reason || 'Рассылка завершена').trim() || 'Рассылка завершена';
}

function isCompletedResponse(response) {
  const status = normalizedStatus(response);
  return Boolean(
    response?.completed
    || response?.mailing_completed
    || response?.mailingCompleted
    || response?.all_done
    || response?.allDone
    || ['completed', 'complete', 'finished', 'done', 'all_done'].includes(status)
  );
}

function isNoTaskResponse(response) {
  const status = normalizedStatus(response);
  return Boolean(response?.no_task || response?.noTask || ['no_task', 'empty'].includes(status));
}

function isTemporaryNoTaskResponse(response) {
  const status = normalizedStatus(response);
  return Boolean(
    response?.temporary
    || response?.wait
    || response?.retry_later
    || response?.retryLater
    || ['waiting', 'wait', 'pending', 'retry_later'].includes(status)
  );
}

function normalizedStatus(response) {
  return String(response?.status || response?.state || '').trim().toLowerCase();
}


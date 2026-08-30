export const LEAD_FAILURE_REASONS = new Set([
  'no_message_button',
  'profile_unavailable',
  'message_text_empty',
  'send_confirmation_missing',
  'n8n_timeout'
]);

export const ACCOUNT_FAILURE_REASONS = new Set(['login_required', 'instagram_restricted']);

export class ExecutorJobError extends Error {
  constructor(reason, message, category = '') {
    super(message);
    this.reason = reason;
    this.category = category || (isLeadFailure(reason) ? 'lead' : 'system');
  }
}

export function assertNotStopped(control = {}) {
  if (control.stop) throw new ExecutorJobError('stopped', 'Исполнитель остановлен', 'system');
}

export function isLeadFailure(reason) {
  return LEAD_FAILURE_REASONS.has(reason);
}

export function classifyError(error) {
  if (error?.reason) return error.reason;
  const message = String(error?.message || error || '');
  if (/log in|войти/i.test(message)) return 'login_required';
  if (/3 минуты|timeout|abort/i.test(message)) return 'n8n_timeout';
  if (/challenge|checkpoint|temporarily blocked|try again later|огранич/i.test(message)) return 'instagram_restricted';
  if (/кнопка сообщения|message/i.test(message)) return 'no_message_button';
  if (/недоступ/i.test(message)) return 'profile_unavailable';
  return 'browser_error';
}

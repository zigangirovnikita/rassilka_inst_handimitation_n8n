import { ExecutorJobError } from './executorErrors.js';

const MESSAGE_BUTTON_PATTERN = /^(message|send message|сообщение|отправить сообщение|написать)$/i;

export function isMessageButtonLabel(label) {
  return MESSAGE_BUTTON_PATTERN.test(String(label || '').trim());
}

export async function openProfileAndCapture(page, job) {
  const expectedUrl = `https://www.instagram.com/${job.targetUsername}/`;
  await page.goto(job.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!page.url().startsWith(expectedUrl)) {
    await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  await waitForInstagramProfileReady(page);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  assertInstagramState(bodyText, page.url());
  if (/log in|sign up|войдите|зарегистрируйтесь/i.test(bodyText)) {
    throw new ExecutorJobError('login_required', 'Instagram просит повторно войти в аккаунт', 'account');
  }
  if (/sorry, this page isn't available|страница недоступна/i.test(bodyText)) {
    throw new ExecutorJobError('profile_unavailable', 'Профиль недоступен', 'lead');
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

export async function sendInstagramMessage(page, messageText) {
  const messageButton = messageButtonLocator(page);
  if (!(await messageButton.count())) throw new ExecutorJobError('no_message_button', 'Кнопка сообщения недоступна', 'lead');
  await messageButton.click({ timeout: 15_000 });
  const textbox = await waitForMessageTextbox(page);
  await textbox.click({ timeout: 10_000 }).catch(() => {});
  await textbox.fill(messageText, { timeout: 10_000 });
  const sendButton = page.getByRole('button', { name: /^(send|отправить)$/i }).last();
  if (await sendButton.count()) await sendButton.click({ timeout: 10_000 });
  else await page.keyboard.press('Enter');
  await confirmInstagramSend(page, textbox, messageText);
}

export function normalizeMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
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

async function hasMessageButton(page) {
  return await messageButtonLocator(page).count() > 0;
}

function messageButtonLocator(page) {
  return page.getByRole('button', { name: MESSAGE_BUTTON_PATTERN }).first();
}

async function waitForMessageTextbox(page) {
  const textbox = page.locator('[contenteditable="true"][role="textbox"], textarea, div[aria-label][contenteditable="true"]').last();
  await textbox.waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {
      throw new ExecutorJobError('message_box_missing', 'Поле ввода сообщения недоступно', 'system');
    });
  return textbox;
}

async function confirmInstagramSend(page, textbox, messageText) {
  const deadline = Date.now() + 20_000;
  const normalized = normalizeMessageText(messageText);
  while (Date.now() < deadline) {
    await assertNoSendError(page);
    if (normalized && await page.getByText(normalized, { exact: true }).last().isVisible().catch(() => false)) return;
    if (await isComposerCleared(textbox)) return;
    await page.waitForTimeout(500);
  }
  throw new ExecutorJobError('send_confirmation_missing', 'Instagram не подтвердил отправку сообщения', 'lead');
}

async function isComposerCleared(textbox) {
  const text = await textbox.innerText({ timeout: 1000 }).catch(() => '');
  const value = await textbox.inputValue({ timeout: 1000 }).catch(() => '');
  return !normalizeMessageText(text || value);
}

async function waitForInstagramProfileReady(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => document.body && document.body.innerText.length > 20, null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

function assertInstagramState(bodyText, url) {
  const text = String(bodyText || '');
  if (/challenge|checkpoint|help us confirm|confirm it's you|подтвердите|проверка безопасности/i.test(`${url}\n${text}`)) {
    throw new ExecutorJobError('instagram_restricted', 'Instagram требует проверку аккаунта', 'account');
  }
  if (/temporarily blocked|try again later|we limit how often|действие заблокировано|попробуйте позже|ограничиваем/i.test(text)) {
    throw new ExecutorJobError('instagram_restricted', 'Instagram временно ограничил действия аккаунта', 'account');
  }
}

async function assertNoSendError(page) {
  const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
  if (/couldn.t send|failed to send|не удалось отправить|попробуйте позже|try again later/i.test(text)) {
    const error = new ExecutorJobError('send_confirmation_missing', 'Instagram показал ошибку отправки сообщения', 'lead');
    error.instagramSendRejected = true;
    throw error;
  }
}

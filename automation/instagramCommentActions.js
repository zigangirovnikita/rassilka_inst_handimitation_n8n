import { ExecutorJobError } from './executorErrors.js';
import { openInstagramProfile } from './instagramPageActions.js';

const PINNED_PATTERN = /pinned|закреплен|прикреплен/i;
const COMMENT_BUTTON_PATTERN = /^(comment|комментировать)$/i;
const COMMENT_FIELD_PATTERN = /add a comment|добавьте комментарий/i;
const POST_COMMENT_PATTERN = /^(post|publish|опубликовать)$/i;

export async function openCommentPublication(page, job) {
  await openInstagramProfile(page, job);
  const candidates = await readPublicationCandidates(page, job.targetUsername);
  const selected = chooseCommentPublication(candidates);
  if (!selected) {
    throw new ExecutorJobError('publication_missing', 'В профиле нет публикаций для комментария', 'lead');
  }

  const postUrl = new URL(selected.href, 'https://www.instagram.com/').toString();
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  assertCommentPageState(bodyText, page.url());
  return { postUrl: page.url(), selection: selected.selection };
}

export async function sendInstagramComment(page, commentText) {
  let textbox = commentTextboxLocator(page);
  if (!(await textbox.count())) {
    const commentButton = page.getByRole('button', { name: COMMENT_BUTTON_PATTERN }).first();
    if (await commentButton.count()) await commentButton.click({ timeout: 10_000 }).catch(() => {});
    textbox = commentTextboxLocator(page);
  }
  await textbox.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
    throw new ExecutorJobError('comment_box_missing', 'Поле комментария недоступно', 'lead');
  });

  const normalized = normalizeCommentText(commentText);
  const matchingBefore = await page.getByText(normalized, { exact: true }).count().catch(() => 0);
  await textbox.click({ timeout: 10_000 }).catch(() => {});
  await textbox.fill(commentText, { timeout: 10_000 });

  const form = textbox.locator('xpath=ancestor::form[1]');
  const postButton = (await form.count()
    ? form.getByRole('button', { name: POST_COMMENT_PATTERN })
    : page.getByRole('button', { name: POST_COMMENT_PATTERN })).last();
  await postButton.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
    throw new ExecutorJobError('comment_submit_missing', 'Кнопка публикации комментария недоступна', 'lead');
  });
  await postButton.click({ timeout: 10_000 });
  await confirmInstagramComment(page, textbox, normalized, matchingBefore);
}

export function chooseCommentPublication(candidates) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    if (!candidate?.href || seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    unique.push(candidate);
  }
  const pinned = unique.filter(candidate => candidate.pinned);
  const regular = unique.filter(candidate => !candidate.pinned);
  if (regular.length >= 2) return { ...regular[1], selection: 'second_regular' };
  if (regular.length === 1) return { ...regular[0], selection: 'only_regular' };
  if (pinned.length >= 2) return { ...pinned[1], selection: 'second_pinned_fallback' };
  if (pinned.length === 1) return { ...pinned[0], selection: 'only_pinned_fallback' };
  return null;
}

export function isPublicationHref(href, username = '') {
  const escapedUsername = escapeRegExp(String(username || '').replace(/^@/, '').trim());
  const prefix = escapedUsername ? `(?:${escapedUsername}/)?` : '(?:[A-Za-z0-9._]{1,30}/)?';
  return new RegExp(`^/${prefix}(?:p|reel)/[A-Za-z0-9_-]+/?(?:\\?.*)?$`, 'i').test(String(href || ''));
}

async function readPublicationCandidates(page, username) {
  return page.locator('a[href]').evaluateAll((links, input) => {
    const hrefPattern = new RegExp(input.hrefPatternSource, 'i');
    const pinnedPattern = new RegExp(input.pinnedPatternSource, 'i');
    return links.map(link => {
      const labels = [
        link.getAttribute('aria-label') || '',
        link.getAttribute('title') || '',
        link.textContent || '',
        ...[...link.querySelectorAll('svg')].flatMap(svg => [
          svg.getAttribute('aria-label') || '',
          svg.querySelector('title')?.textContent || ''
        ])
      ].join(' ');
      return {
        href: link.getAttribute('href') || '',
        pinned: pinnedPattern.test(labels)
      };
    }).filter(candidate => hrefPattern.test(candidate.href));
  }, {
    hrefPatternSource: publicationHrefPattern(username).source,
    pinnedPatternSource: PINNED_PATTERN.source
  });
}

function publicationHrefPattern(username) {
  const escapedUsername = escapeRegExp(String(username || '').replace(/^@/, '').trim());
  const prefix = escapedUsername ? `(?:${escapedUsername}/)?` : '(?:[A-Za-z0-9._]{1,30}/)?';
  return new RegExp(`^/${prefix}(?:p|reel)/[A-Za-z0-9_-]+/?(?:\\?.*)?$`, 'i');
}

function commentTextboxLocator(page) {
  return page.getByRole('textbox', { name: COMMENT_FIELD_PATTERN })
    .or(page.getByPlaceholder(COMMENT_FIELD_PATTERN)).last();
}

async function confirmInstagramComment(page, textbox, normalized, matchingBefore) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    assertCommentPageState(bodyText, page.url());
    if (/couldn.t post comment|comment failed|не удалось опубликовать комментарий|попробуйте позже|try again later/i.test(bodyText)) {
      const error = new ExecutorJobError('comment_confirmation_missing', 'Instagram показал ошибку отправки комментария', 'lead');
      error.instagramSendRejected = true;
      throw error;
    }
    const matchingNow = await page.getByText(normalized, { exact: true }).count().catch(() => 0);
    if (matchingNow > matchingBefore) return;
    const value = await textbox.inputValue({ timeout: 1000 }).catch(() => '');
    if (!normalizeCommentText(value) && matchingNow > 0) return;
    await page.waitForTimeout(500);
  }
  throw new ExecutorJobError('comment_confirmation_missing', 'Instagram не подтвердил публикацию комментария', 'lead');
}

function assertCommentPageState(bodyText, url) {
  const text = String(bodyText || '');
  if (/challenge|checkpoint|help us confirm|confirm it's you|подтвердите|проверка безопасности/i.test(`${url}\n${text}`)) {
    throw new ExecutorJobError('instagram_restricted', 'Instagram требует проверку аккаунта', 'account');
  }
  if (/temporarily blocked|we limit how often|действие заблокировано|ограничиваем/i.test(text)) {
    throw new ExecutorJobError('instagram_restricted', 'Instagram временно ограничил действия аккаунта', 'account');
  }
  if (/log in|sign up|войдите|зарегистрируйтесь/i.test(text)) {
    throw new ExecutorJobError('login_required', 'Instagram просит повторно войти в аккаунт', 'account');
  }
  if (/comments on this post have been limited|comments are turned off|комментарии к этой публикации ограничены|комментарии отключены/i.test(text)) {
    throw new ExecutorJobError('comments_disabled', 'Комментарии к публикации отключены', 'lead');
  }
  if (/sorry, this page isn't available|страница недоступна/i.test(text)) {
    throw new ExecutorJobError('post_unavailable', 'Публикация недоступна', 'lead');
  }
}

function normalizeCommentText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

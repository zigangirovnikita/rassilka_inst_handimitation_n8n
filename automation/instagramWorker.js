import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

let loginContext = null;
const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
];

export async function openChromeContext(appRoot, savedProfileDir = '', options = {}) {
  const dir = savedProfileDir || join(appRoot, 'profiles', 'igp_default');
  mkdirSync(dir, { recursive: true });
  return chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: !options.interactive,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 860 }
  });
}

export async function checkChromeAvailable() {
  try {
    const executable = chromium.executablePath('chrome');
    if (executable && existsSync(executable)) return { ok: true, executable };
  } catch {
    // Fall through to user-facing message below.
  }
  const macPath = MAC_CHROME_PATHS.find(path => path && existsSync(path));
  if (macPath) return { ok: true, executable: macPath };
  let browser = null;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    return { ok: true, executable: 'chrome' };
  } catch {
    return {
      ok: false,
      message: 'Google Chrome не найден. Установите Google Chrome и перезапустите приложение.'
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function openInstagramLogin(appRoot, savedProfileDir = '') {
  await closeLoginContext();
  loginContext = await openChromeContext(appRoot, savedProfileDir, { interactive: true });
  try {
    const page = loginContext.pages()[0] || await loginContext.newPage();
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 180_000;
    let username = '';
    while (Date.now() < deadline && !username) {
      username = await detectUsername(page, '', { navigate: false, legacyFallback: false }).catch(error => {
        if (/временно не удалось определить/i.test(error.message)) return '';
        throw error;
      });
      if (!username) await page.waitForTimeout(2000);
    }
    if (!username) throw new Error('Instagram открыт, но ник аккаунта определить не удалось');
    return { username, profileDir: savedProfileDir || join(appRoot, 'profiles', 'igp_default'), connected: true };
  } finally {
    await closeLoginContext();
  }
}

export async function detectInstagramAccount(appRoot, savedProfileDir = '', expectedUsername = '') {
  await closeLoginContext();
  const context = await openChromeContext(appRoot, savedProfileDir);
  try {
    const page = context.pages()[0] || await context.newPage();
    const username = await detectUsername(page, expectedUsername);
    return { username: username || '', profileDir: savedProfileDir || join(appRoot, 'profiles', 'igp_default'), connected: Boolean(username) };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function detectUsernameForTest(page, expectedUsername = '', options = {}) {
  return detectUsername(page, expectedUsername, options);
}

async function detectUsername(page, expectedUsername = '', options = {}) {
  const navigate = options.navigate !== false;
  const legacyFallback = options.legacyFallback !== false;
  if (navigate) await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  const expected = String(expectedUsername || '').replace(/^@/, '').trim();
  if (expected && profileUsernameFromHref(await page.locator(`a[href="/${expected}/"]`).first().getAttribute('href').catch(() => ''))) {
    return expected;
  }
  const apiUsername = await readInstagramViewerUsername(page);
  if (apiUsername) return apiUsername;
  const anchorUsername = profileUsernameFromAnchorData(await readInstagramAnchors(page));
  if (anchorUsername) return anchorUsername;
  const loginVisible = /login|accounts\/login/i.test(page.url())
    || await page.locator('input[name="username"], input[name="password"]').count() > 0;
  if (loginVisible) return '';
  if (!legacyFallback) throw new Error('Instagram открыт, но ник временно не удалось определить');
  return legacyEditFallback(page);
}

async function readInstagramViewerUsername(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/accounts/edit/web_form_data/', { credentials: 'include' }).catch(() => null);
    if (!response?.ok) return '';
    const data = await response.json().catch(() => null);
    return data?.form_data?.username || data?.username || '';
  }).catch(() => '');
}

async function readInstagramAnchors(page) {
  return page.locator('a[href^="/"]').evaluateAll(links => links.map(link => ({
    href: link.getAttribute('href') || '',
    text: link.textContent || '',
    ariaLabel: link.getAttribute('aria-label') || ''
  }))).catch(() => []);
}

export function profileUsernameFromAnchorData(anchors) {
  const blocked = new Set(['accounts', 'direct', 'explore', 'reels', 'p', 'stories', 'about', 'developer', 'legal', 'privacy']);
  for (const anchor of anchors || []) {
    const username = profileUsernameFromHref(anchor.href);
    if (!username || blocked.has(username.toLowerCase())) continue;
    const label = `${anchor.text || ''} ${anchor.ariaLabel || ''}`;
    if (/profile|профиль/i.test(label)) return username;
  }
  return '';
}

export function profileUsernameFromHref(href) {
  const match = String(href || '').match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
  return match ? match[1] : '';
}

async function legacyEditFallback(page) {
  await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  const username = await page.locator('input[name="username"]').inputValue().catch(() => '');
  if (!username) throw new Error('Instagram открыт, но ник временно не удалось определить');
  return username;
}

async function closeLoginContext() {
  if (!loginContext) return;
  const context = loginContext;
  loginContext = null;
  await context.close().catch(() => {});
}

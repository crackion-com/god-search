import { launch } from 'cloakbrowser';

let _browser = null;
let _launchPromise = null;

// Limit concurrent browser page navigations to prevent CloakBrowser crashes
const MAX_NAV = 2;
let _navCount = 0;
const _navQueue = [];

async function _acquireNav() {
  if (_navCount < MAX_NAV) { _navCount++; return; }
  await new Promise(r => _navQueue.push(r));
  _navCount++;
}

function _releaseNav() {
  _navCount = Math.max(0, _navCount - 1);
  if (_navQueue.length) _navQueue.shift()();
}

async function _launchBrowser() {
  const b = await launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  b.on('disconnected', () => {
    console.error('[browser] disconnected — will relaunch on next use');
    _browser = null;
  });
  _browser = b;
  _launchPromise = null;
  console.error('[browser] launched');
  return b;
}

export async function ensureBrowser() {
  if (_browser?.isConnected()) return _browser;
  if (_launchPromise) return _launchPromise;
  _launchPromise = _launchBrowser();
  return _launchPromise;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    console.error('[browser] closed');
  }
}

// Run fn(page) with exclusive browser access — one engine at a time
export async function withBrowserPage(fn) {
  await _acquireNav();
  const browser = await ensureBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    _releaseNav();
  }
}

export function browserStatus() {
  return { connected: !!_browser?.isConnected() };
}

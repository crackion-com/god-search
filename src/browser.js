import { launch } from 'cloakbrowser';
import { BROWSER_CONFIG } from './config.js';

let _browser = null;
let _launchPromise = null;
let _launchCount = 0;
let _disconnectCount = 0;
let _lastLaunchAt = null;
let _lastLaunchError = null;
let _launchImpl = launch;

// Limit concurrent browser page navigations to prevent CloakBrowser crashes
let _navCount = 0;
const _navQueue = [];

export function __setLaunchForTests(fn) {
  _launchImpl = fn || launch;
}

export function __resetForTests() {
  _browser = null;
  _launchPromise = null;
  _launchCount = 0;
  _disconnectCount = 0;
  _lastLaunchAt = null;
  _lastLaunchError = null;
  _navCount = 0;
  _navQueue.length = 0;
  _launchImpl = launch;
}

async function _acquireNav() {
  if (_navCount < BROWSER_CONFIG.maxNav) { _navCount++; return; }
  await new Promise(r => _navQueue.push(r));
  _navCount++;
}

function _releaseNav() {
  _navCount = Math.max(0, _navCount - 1);
  if (_navQueue.length) _navQueue.shift()();
}

async function _launchBrowser() {
  try {
    const b = await _launchImpl({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    b.on('disconnected', () => {
      console.error('[browser] disconnected — will relaunch on next use');
      _disconnectCount++;
      _browser = null;
    });
    _browser = b;
    _launchPromise = null;
    _launchCount++;
    _lastLaunchAt = new Date().toISOString();
    _lastLaunchError = null;
    console.error('[browser] launched');
    return b;
  } catch (err) {
    _launchPromise = null;
    _lastLaunchError = {
      at: new Date().toISOString(),
      name: err?.name || 'Error',
      message: err?.message || String(err),
    };
    throw err;
  }
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

// Run fn(page) with a throttled browser page.
export async function withBrowserPage(fn) {
  await _acquireNav();
  let page = null;
  try {
    const browser = await ensureBrowser();
    page = await browser.newPage();
    return await fn(page);
  } finally {
    if (page) await page.close().catch(() => {});
    _releaseNav();
  }
}

export function browserStatus() {
  return {
    connected: !!_browser?.isConnected(),
    launch_count: _launchCount,
    disconnect_count: _disconnectCount,
    last_launch_at: _lastLaunchAt,
    last_launch_error: _lastLaunchError,
    max_nav: BROWSER_CONFIG.maxNav,
    active_nav: _navCount,
    queued_nav: _navQueue.length,
  };
}

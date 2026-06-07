/**
 * Deterministic browser manager tests.
 *
 * Run:
 *   node test/verify-browser.js
 */

import {
  __resetForTests as resetBrowserForTests,
  __setLaunchForTests,
  browserStatus,
  ensureBrowser,
  withBrowserPage,
} from '../src/browser.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed += 1;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

async function runTest(name, fn) {
  console.log(`\n${INFO} ${name}`);
  try {
    resetBrowserForTests();
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeBrowser({ newPageImpl } = {}) {
  let connected = true;
  const handlers = new Map();
  const pages = [];
  const browser = {
    pages,
    closed: false,
    isConnected() {
      return connected;
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event) {
      handlers.get(event)?.();
    },
    async close() {
      browser.closed = true;
      connected = false;
    },
    async newPage() {
      if (newPageImpl) return newPageImpl();
      const page = {
        closed: false,
        async close() {
          page.closed = true;
        },
      };
      pages.push(page);
      return page;
    },
  };
  return browser;
}

async function waitUntil(label, predicate, timeoutMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(false, label, `status=${JSON.stringify(browserStatus())}`);
  return false;
}

await runTest('deduplicates concurrent launch requests', async () => {
  const ready = deferred();
  const browser = createFakeBrowser();
  let calls = 0;
  let launchOptions = null;

  __setLaunchForTests(async options => {
    calls += 1;
    launchOptions = options;
    await ready.promise;
    return browser;
  });

  const first = ensureBrowser();
  const second = ensureBrowser();
  ready.resolve();

  const [a, b] = await Promise.all([first, second]);
  const status = browserStatus();

  assert(a === browser && b === browser, 'concurrent callers receive the same browser');
  assert(calls === 1, 'launch called once', `called ${calls}`);
  assert(status.launch_count === 1, 'launch count records one successful launch');
  assert(status.connected === true, 'browser reports connected after launch');
  assert(launchOptions?.headless === true, 'launch uses headless mode');
  assert(launchOptions?.args?.includes('--no-sandbox'), 'launch passes sandbox-safe args');
});

await runTest('records launch errors and allows retry', async () => {
  const browser = createFakeBrowser();
  let calls = 0;

  __setLaunchForTests(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('planned launch failure');
      err.name = 'LaunchError';
      throw err;
    }
    return browser;
  });

  const err = await ensureBrowser().catch(error => error);
  const failedStatus = browserStatus();
  const retry = await ensureBrowser();
  const retryStatus = browserStatus();

  assert(err?.message === 'planned launch failure', 'launch failure is surfaced');
  assert(failedStatus.last_launch_error?.name === 'LaunchError', 'launch error name is recorded');
  assert(failedStatus.last_launch_error?.message === 'planned launch failure', 'launch error message is recorded');
  assert(calls === 2, 'retry launches again after failure', `called ${calls}`);
  assert(retry === browser, 'retry returns browser');
  assert(retryStatus.launch_count === 1, 'successful retry increments launch count once');
  assert(retryStatus.last_launch_error === null, 'successful retry clears last launch error');
});

await runTest('relaunches after browser disconnect', async () => {
  const firstBrowser = createFakeBrowser();
  const secondBrowser = createFakeBrowser();
  const launched = [firstBrowser, secondBrowser];
  let calls = 0;

  __setLaunchForTests(async () => launched[calls++]);

  const first = await ensureBrowser();
  first.emit('disconnected');
  const disconnectedStatus = browserStatus();
  const second = await ensureBrowser();
  const status = browserStatus();

  assert(first === firstBrowser, 'first launch returns first browser');
  assert(disconnectedStatus.connected === false, 'disconnect clears active browser');
  assert(disconnectedStatus.disconnect_count === 1, 'disconnect count increments');
  assert(second === secondBrowser, 'next ensure relaunches browser');
  assert(status.launch_count === 2, 'launch count includes relaunch');
});

await runTest('withBrowserPage closes pages and releases slots', async () => {
  const browser = createFakeBrowser();
  __setLaunchForTests(async () => browser);

  const value = await withBrowserPage(async page => {
    page.seen = true;
    return 'ok';
  });
  const page = browser.pages[0];
  const status = browserStatus();

  assert(value === 'ok', 'withBrowserPage returns callback value');
  assert(page?.seen === true, 'callback receives page');
  assert(page?.closed === true, 'page closes after callback');
  assert(status.active_nav === 0, 'navigation slot is released');
  assert(status.queued_nav === 0, 'navigation queue is empty');
});

await runTest('withBrowserPage releases slots when launch fails', async () => {
  let calls = 0;
  __setLaunchForTests(async () => {
    calls += 1;
    throw new Error('launch unavailable');
  });

  const err = await withBrowserPage(async () => 'unreachable').catch(error => error);
  const status = browserStatus();

  assert(err?.message === 'launch unavailable', 'launch error is surfaced through page helper');
  assert(calls === 1, 'launch attempted once', `called ${calls}`);
  assert(status.active_nav === 0, 'navigation slot is released after launch failure');
  assert(status.queued_nav === 0, 'navigation queue is empty after launch failure');
  assert(status.last_launch_error?.message === 'launch unavailable', 'launch failure is recorded');
});

await runTest('throttles concurrent page work', async () => {
  const browser = createFakeBrowser();
  const releases = [];
  __setLaunchForTests(async () => browser);

  const maxNav = browserStatus().max_nav;
  const tasks = Array.from({ length: maxNav + 1 }, (_, index) =>
    withBrowserPage(async () => {
      const gate = deferred();
      releases[index] = gate.resolve;
      await gate.promise;
      return index;
    })
  );

  await waitUntil(
    'first batch reaches max active navigation',
    () => browserStatus().active_nav === maxNav
      && Array.from({ length: maxNav }, (_, index) => typeof releases[index] === 'function').every(Boolean)
  );
  assert(browserStatus().queued_nav === 1, 'extra page work is queued');

  releases[0]();
  await waitUntil(
    'queued page work starts after a slot releases',
    () => Array.from({ length: maxNav + 1 }, (_, index) => typeof releases[index] === 'function').every(Boolean)
  );
  assert(browserStatus().queued_nav === 0, 'queue drains after slot release');

  for (const release of releases.slice(1)) release();
  const values = await Promise.all(tasks);
  const status = browserStatus();

  assert(values.join(',') === Array.from({ length: maxNav + 1 }, (_, index) => index).join(','), 'all queued work completes in order');
  assert(browser.pages.length === maxNav + 1, 'all page tasks opened a page');
  assert(browser.pages.every(page => page.closed), 'all pages are closed');
  assert(status.active_nav === 0, 'all navigation slots are released');
});

resetBrowserForTests();

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);

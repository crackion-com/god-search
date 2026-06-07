/**
 * Deterministic browser-backed engine tests.
 *
 * Run:
 *   node test/verify-browser-engines.js
 */

import {
  __resetForTests as resetBrowserForTests,
  __setLaunchForTests,
} from '../src/browser.js';
import { SEARCH_CONFIG } from '../src/config.js';
import { searchBing } from '../src/engines/bing.js';
import { searchBrave, __resetForTests as resetBraveForTests } from '../src/engines/brave.js';
import { searchDdg } from '../src/engines/ddg.js';
import { searchGoogle } from '../src/engines/google.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;

const originalFetch = globalThis.fetch;
const originalSearchConfig = { ...SEARCH_CONFIG };

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed += 1;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

async function expectThrows(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'did not throw');
    return null;
  } catch (err) {
    assert(pattern.test(err?.message || String(err)), label, err?.message || String(err));
    return err;
  }
}

async function runTest(name, fn) {
  console.log(`\n${INFO} ${name}`);
  resetAll();
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  } finally {
    resetAll();
  }
}

function resetAll() {
  resetBrowserForTests();
  resetBraveForTests();
  Object.assign(SEARCH_CONFIG, originalSearchConfig);
  globalThis.fetch = originalFetch;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function installFetchMock(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length - 1);
  };
  return calls;
}

function base64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function candidate({ title, url, snippet, mode = 'primary', rank = 1 }) {
  return {
    title,
    url,
    snippet,
    extractionMode: mode,
    sourceRank: rank,
    warnings: [],
    signals: {
      anchorArea: 2400,
      containerTextLength: 160,
      containerText: `${title} ${snippet}`,
      hasHeading: true,
      hasResultClass: true,
      hidden: false,
      inMain: true,
      inArticle: false,
      inRoleMain: false,
      inNav: false,
      inFooter: false,
      inHeader: false,
      inAside: false,
      isAd: false,
      isPagination: false,
      isSettings: false,
      selector: 'test',
    },
  };
}

function createFakePage({ candidates = [], classificationStatus = 'ok' } = {}) {
  let currentUrl = '';
  const calls = [];
  const page = {
    calls,
    closed: false,
    url() {
      return currentUrl;
    },
    async goto(url, options) {
      currentUrl = String(url);
      calls.push({ type: 'goto', url: currentUrl, options });
    },
    async waitForLoadState(state, options) {
      calls.push({ type: 'waitForLoadState', state, options });
    },
    async waitForSelector(selector, options) {
      calls.push({ type: 'waitForSelector', selector, options });
    },
    async evaluate(_fn, input) {
      calls.push({ type: 'evaluate', input });
      if (input?.blockedSignals && input?.consentSignals && !input?.mode) {
        return {
          status: classificationStatus,
          confidence: classificationStatus === 'ok' ? 0.9 : 0.95,
          signals: {
            blocked: classificationStatus === 'blocked' ? ['captcha'] : [],
            blockedSelectors: [],
            consent: classificationStatus === 'consent' ? ['consent'] : [],
            consentSelectors: [],
            visibleResultAnchors: candidates.length,
          },
          diagnostics: {
            title: 'Fake SERP',
            url: currentUrl,
            bodyTextLength: 500,
          },
        };
      }
      if (input?.mode) {
        return input.mode === 'primary'
          ? candidates.map((item, index) => ({ ...item, sourceRank: item.sourceRank || index + 1 }))
          : [];
      }
      return undefined;
    },
    async close() {
      page.closed = true;
    },
  };
  return page;
}

function installFakeBrowser(page) {
  const browser = {
    isConnected() {
      return true;
    },
    on() {},
    async close() {},
    async newPage() {
      return page;
    },
  };
  __setLaunchForTests(async () => browser);
  return browser;
}

function onlyGoto(page) {
  return page.calls.find(call => call.type === 'goto');
}

await runTest('DDG browser scrape maps extracted results and request params', async () => {
  const target = 'https://example.com/ddg-guide?utm_source=serp#top';
  const page = createFakePage({
    candidates: [
      candidate({
        title: 'Agent Search Guide',
        url: `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`,
        snippet: 'Agent search systems and browser extraction notes.',
      }),
    ],
  });
  installFakeBrowser(page);

  const results = await searchDdg('agent search', 3);
  const requested = new URL(onlyGoto(page).url);

  assert(requested.origin + requested.pathname === 'https://html.duckduckgo.com/html/', 'uses DDG HTML endpoint');
  assert(requested.searchParams.get('q') === 'agent search', 'sets DDG query parameter');
  assert(results.length === 1, 'returns one mapped DDG result');
  assert(results[0].url === 'https://example.com/ddg-guide', 'unwraps DDG redirect and strips tracking/hash');
  assert(results[0].engine === 'ddg', 'maps DDG engine field');
  assert(results[0].domain === 'example.com', 'maps DDG domain');
  assert(page.closed === true, 'closes DDG page');
});

await runTest('Google browser scrape maps extracted results and drops Google self links', async () => {
  const page = createFakePage({
    candidates: [
      candidate({
        title: 'Google self search',
        url: 'https://www.google.com/search?q=agent+search',
        snippet: 'Navigation result that should be rejected.',
      }),
      candidate({
        title: 'Agent Search Reference',
        url: 'https://docs.example.com/agents/reference',
        snippet: 'Reference documentation for agent search extraction.',
        rank: 2,
      }),
    ],
  });
  installFakeBrowser(page);

  const results = await searchGoogle('agent search', 2);
  const requested = new URL(onlyGoto(page).url);

  assert(requested.origin + requested.pathname === 'https://www.google.com/search', 'uses Google search endpoint');
  assert(requested.searchParams.get('q') === 'agent search', 'sets Google query parameter');
  assert(requested.searchParams.get('num') === '10', 'sets Google result count hint');
  assert(requested.searchParams.get('hl') === 'en', 'sets Google language hint');
  assert(results.length === 1, 'filters Google self link');
  assert(results[0].url === 'https://docs.example.com/agents/reference', 'keeps external Google result');
  assert(results[0].engine === 'google', 'maps Google engine field');
  assert(page.calls.some(call => call.type === 'evaluate' && !call.input), 'runs Google consent click hook');
});

await runTest('Bing browser scrape decodes redirect results and request params', async () => {
  const target = 'https://learn.example.org/bing-result?msclkid=abc';
  const page = createFakePage({
    candidates: [
      candidate({
        title: 'Bing Result Guide',
        url: `https://www.bing.com/ck/a?u=a1${base64Url(target)}`,
        snippet: 'Bing result with redirect URL for extraction.',
      }),
    ],
  });
  installFakeBrowser(page);

  const results = await searchBing('browser search', 4);
  const requested = new URL(onlyGoto(page).url);

  assert(requested.origin + requested.pathname === 'https://www.bing.com/search', 'uses Bing search endpoint');
  assert(requested.searchParams.get('q') === 'browser search', 'sets Bing query parameter');
  assert(requested.searchParams.get('setLang') === 'en', 'sets Bing language');
  assert(requested.searchParams.get('mkt') === 'en-US', 'sets Bing market');
  assert(results.length === 1, 'returns one mapped Bing result');
  assert(results[0].url === 'https://learn.example.org/bing-result', 'decodes Bing redirect and strips tracking');
  assert(results[0].engine === 'bing', 'maps Bing engine field');
  assert(page.calls.some(call => call.type === 'waitForSelector'), 'waits for Bing result selector');
});

await runTest('Bing empty known-positive scrape is typed as selector miss', async () => {
  const page = createFakePage({ candidates: [], classificationStatus: 'ok' });
  installFakeBrowser(page);

  const err = await expectThrows(() => searchBing('openai', 4), /selector_miss|empty_suspect/, 'throws typed Bing empty suspect');

  assert(err?.provider === 'bing', 'Bing empty suspect records provider');
  assert(err?.code === 'selector_miss', 'Bing empty suspect records selector miss code');
  assert(err?.state === 'empty_suspect', 'Bing empty suspect records state');
  assert(err?.degradation === true, 'Bing empty suspect is marked as degradation');
  assert(page.closed === true, 'closes Bing page after typed empty suspect');
});

await runTest('Brave browser scrape maps extracted results and request params', async () => {
  SEARCH_CONFIG.braveMode = 'browser';
  SEARCH_CONFIG.braveApiKey = '';
  const page = createFakePage({
    candidates: [
      candidate({
        title: 'Brave Search Result',
        url: 'https://answers.example.net/brave',
        snippet: 'Brave browser SERP extraction result.',
      }),
    ],
  });
  installFakeBrowser(page);

  const results = await searchBrave('private search', 2);
  const requested = new URL(onlyGoto(page).url);

  assert(requested.origin + requested.pathname === 'https://search.brave.com/search', 'uses Brave browser endpoint');
  assert(requested.searchParams.get('q') === 'private search', 'sets Brave query parameter');
  assert(requested.searchParams.get('source') === 'web', 'sets Brave web source');
  assert(results.length === 1, 'returns one mapped Brave browser result');
  assert(results[0].engine === 'brave', 'maps Brave browser engine field');
  assert(results[0].domain === 'example.net', 'maps Brave browser domain');
  assert(page.calls.some(call => call.type === 'waitForLoadState' && call.state === 'networkidle'), 'waits for Brave network idle');
});

await runTest('Brave browser challenge is typed as cooldown degradation', async () => {
  SEARCH_CONFIG.braveMode = 'browser';
  SEARCH_CONFIG.braveApiKey = '';
  const page = createFakePage({ candidates: [], classificationStatus: 'blocked' });
  installFakeBrowser(page);

  const first = await expectThrows(() => searchBrave('challenge search', 2), /challenge page.*cooldown/, 'throws typed Brave challenge cooldown');
  assert(first?.provider === 'brave', 'Brave challenge records provider');
  assert(first?.code === 'cooldown', 'Brave challenge records cooldown code');
  assert(first?.state === 'cooldown', 'Brave challenge records cooldown state');
  assert(first?.retry_after_ms === 30000, 'Brave challenge records retry-after ms', `retry_after_ms ${first?.retry_after_ms}`);
  assert(first?.degradation === true, 'Brave challenge is marked as degradation');

  const second = await expectThrows(() => searchBrave('challenge search again', 2), /challenge page.*cooldown/, 'Brave cooldown short-circuits');
  assert(second?.state === 'cooldown', 'Brave short-circuit keeps cooldown state');
  assert(second?.retry_after_ms > 0, 'Brave short-circuit reports remaining cooldown');
});

await runTest('Brave API branch maps results without opening a browser', async () => {
  SEARCH_CONFIG.braveMode = 'api';
  SEARCH_CONFIG.braveApiKey = 'test-key';
  SEARCH_CONFIG.braveApiCountry = 'ca';
  SEARCH_CONFIG.braveApiSearchLang = 'fr';
  __setLaunchForTests(async () => {
    throw new Error('browser should not launch for Brave API');
  });
  const calls = installFetchMock(() => jsonResponse({
    web: {
      results: [
        {
          title: 'Brave API Result',
          url: 'https://api.example.com/brave',
          description: 'Brave API result description.',
        },
      ],
    },
  }));

  const results = await searchBrave('api search', 5);
  const requested = new URL(calls[0].url);

  assert(calls.length === 1, 'Brave API performs one fetch');
  assert(requested.origin + requested.pathname === 'https://api.search.brave.com/res/v1/web/search', 'uses Brave API endpoint');
  assert(requested.searchParams.get('q') === 'api search', 'sets Brave API query parameter');
  assert(requested.searchParams.get('count') === '10', 'sets Brave API count to limit plus buffer');
  assert(requested.searchParams.get('country') === 'ca', 'sets Brave API country');
  assert(requested.searchParams.get('search_lang') === 'fr', 'sets Brave API search language');
  assert(calls[0].options.headers['X-Subscription-Token'] === 'test-key', 'sets Brave API key header');
  assert(results[0]?.engine === 'brave', 'maps Brave API engine field');
  assert(results[0]?.url === 'https://api.example.com/brave', 'maps Brave API result URL');
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);

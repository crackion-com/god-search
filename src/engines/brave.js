import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';
import { extractSerpResults } from '../extraction/serp-extractor.js';
import { providerError } from '../provider-errors.js';

const BRAVE_URL = 'https://search.brave.com/search';
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_EXTRACT_CONFIG = {
  engine: 'brave',
  engineHostnames: ['search.brave.com'],
  primarySelectors: {
    result: ['[data-type="web"]'],
    title: ['.title', '.heading', 'h2', 'h3'],
    link: ['a[href]'],
    snippet: ['.snippet-content', '.snippet', '.description', 'p'],
  },
  adSignals: ['sponsored', 'advertisement'],
  blockedSignals: ['confirm you', 'human being', "i'm not a robot", 'pow captcha'],
  consentSignals: ['brave privacy'],
  noResultSignals: ['no results found', 'no results for'],
};
let _challengeCooldown = 0;

export function __resetForTests() {
  _challengeCooldown = 0;
}

async function searchBraveViaApi(query, limit = 10) {
  if (!SEARCH_CONFIG.braveApiKey) {
    throw new Error('Brave API mode requested but BRAVE_SEARCH_API_KEY is not set');
  }

  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit + 5, 20)));
  url.searchParams.set('country', SEARCH_CONFIG.braveApiCountry);
  url.searchParams.set('search_lang', SEARCH_CONFIG.braveApiSearchLang);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': SEARCH_CONFIG.braveApiKey,
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Brave API: authentication failed (${resp.status})`);
    }
    if (!resp.ok) throw new Error(`Brave API: HTTP ${resp.status}`);
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const results = data?.web?.results;
  if (!Array.isArray(results)) {
    throw new Error('Brave API: unexpected response shape');
  }

  return results
    .map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: (item.description || '').slice(0, 300),
    }))
    .filter(item => item.title && item.url)
    .map(item => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      score: scoreResult(query, item.url, item.title, item.snippet),
      domain: registrableDomain(item.url),
      engine: 'brave',
    }))
    .slice(0, limit);
}

function shouldUseBraveApi() {
  if (SEARCH_CONFIG.braveMode === 'api') return true;
  if (SEARCH_CONFIG.braveMode === 'scrape') return false;
  return !!SEARCH_CONFIG.braveApiKey;
}

function isSearchBraveUrl(urlString) {
  try {
    return /(^|\.)search\.brave\.com$/i.test(new URL(urlString).hostname);
  } catch {
    return true;
  }
}

function normalizeExtractorResults(query, results, limit) {
  return results
    .filter(r => r.title && r.url?.startsWith('http') && !isSearchBraveUrl(r.url))
    .map(r => ({
      title: r.title,
      url: r.url,
      snippet: (r.snippet || '').slice(0, 300),
      score: scoreResult(query, r.url, r.title, r.snippet || ''),
      domain: registrableDomain(r.url),
      engine: 'brave',
    }))
    .slice(0, limit);
}

function handleExtractionStatus(extracted) {
  if (extracted.status === 'empty') return [];
  if (extracted.status === 'blocked') {
    const retryAfterMs = 30_000;
    _challengeCooldown = Date.now() + retryAfterMs;
    throw providerError('Brave challenge page — 30s cooldown', {
      provider: 'brave',
      code: 'cooldown',
      state: 'cooldown',
      retryAfterMs,
      retryable: true,
      degradation: true,
    });
  }
  if (extracted.status === 'consent') {
    throw new Error('Brave consent page prevented result extraction');
  }
  if (extracted.status === 'failed') {
    const reason = extracted.diagnostics?.reason || extracted.diagnostics?.error || 'unknown extractor failure';
    throw new Error(`Brave extraction failed: ${reason}`);
  }
  return null;
}

export async function searchBrave(query, limit = 10) {
  if (shouldUseBraveApi()) {
    return searchBraveViaApi(query, limit);
  }

  if (Date.now() < _challengeCooldown) {
    const retryAfterMs = _challengeCooldown - Date.now();
    throw providerError('Brave challenge page — 30s cooldown', {
      provider: 'brave',
      code: 'cooldown',
      state: 'cooldown',
      retryAfterMs,
      retryable: true,
      degradation: true,
    });
  }

  return withBrowserPage(async (page) => {
    const url = new URL(BRAVE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('source', 'web');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    await page.waitForSelector('[data-type="web"] a[href], .snippet-title a[href], .result-title a[href], main a[href^="http"]', { timeout: 3000 }).catch(() => {});

    const extracted = await extractSerpResults(page, { ...BRAVE_EXTRACT_CONFIG, query, limit: 15 });
    const terminal = handleExtractionStatus(extracted);
    if (terminal !== null) return terminal;

    return normalizeExtractorResults(query, extracted.results || [], limit);
  });
}

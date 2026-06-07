import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';
import { extractSerpResults } from '../extraction/serp-extractor.js';
import { providerError } from '../provider-errors.js';
import { buildLanguageContext } from '../language.js';

const BING_URL = 'https://www.bing.com/search';
const BING_EXTRACT_CONFIG = {
  engine: 'bing',
  engineHostnames: ['bing.com', 'www.bing.com'],
  primarySelectors: {
    result: ['li.b_algo'],
    title: ['h2 a'],
    link: ['h2 a[href]'],
    snippet: ['.b_caption p', '.b_snippet', '[class*="caption"]'],
  },
  redirectRules: [{ hostnames: ['bing.com', 'www.bing.com'], path: '^/ck/a', params: ['u'], encoding: 'base64url' }],
  adSignals: ['sponsored', 'advertisement'],
  blockedSignals: ['unusual traffic', 'verify you are human'],
  consentSignals: ['we use cookies'],
  noResultSignals: ['there are no results for', 'no results found'],
};

function decodeBingUrl(href) {
  try {
    if (!href.includes('bing.com/ck/a')) return href;
    const u = new URL(href);
    const encoded = u.searchParams.get('u') || '';
    if (!encoded) return href;
    const decoded = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return decoded.startsWith('http') ? decoded : href;
  } catch {
    return href;
  }
}

function normalizeExtractorResults(query, results, limit, languageContext) {
  return results
    .map(r => ({ ...r, url: decodeBingUrl(r.url || '') }))
    .filter(r => r.title && r.url?.startsWith('http'))
    .map(r => ({
      title: r.title,
      url: r.url,
      snippet: (r.snippet || '').slice(0, 300),
      score: scoreResult(query, r.url, r.title, r.snippet || '', languageContext),
      domain: registrableDomain(r.url),
      engine: 'bing',
    }))
    .slice(0, limit);
}

function handleExtractionStatus(extracted) {
  if (extracted.status === 'empty') {
    const classification = extracted.diagnostics?.classification;
    const noResultSignals = classification?.signals?.noResults || [];
    if (classification?.status === 'empty' && noResultSignals.length > 0) return [];
    throw providerError('Bing selector_miss: empty_suspect returned 0 results without a no-results signal', {
      provider: 'bing',
      code: 'selector_miss',
      state: 'empty_suspect',
      retryable: true,
      degradation: true,
    });
  }
  if (extracted.status === 'blocked') {
    throw providerError('Bing blocked result extraction', {
      provider: 'bing',
      code: 'blocked',
      state: 'blocked',
      retryable: true,
      degradation: true,
    });
  }
  if (extracted.status === 'consent') {
    throw new Error('Bing consent page prevented result extraction');
  }
  if (extracted.status === 'failed') {
    const reason = extracted.diagnostics?.reason || extracted.diagnostics?.error || 'unknown extractor failure';
    throw new Error(`Bing extraction failed: ${reason}`);
  }
  return null;
}

async function fallbackExtractBingResults(page, query, limit, languageContext) {
  const raw = await page.evaluate((maxItems) => {
    const items = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('h2 a[href]')) {
      if (items.length >= maxItems) break;
      const href = link.getAttribute('href') || '';
      const title = (link.textContent || link.innerText || '').replace(/\s+/g, ' ').trim();
      if (!href.startsWith('http') || !title || seen.has(href)) continue;
      seen.add(href);
      const container = link.closest('li.b_algo, article, section, div');
      const snippet = (
        container?.querySelector('.b_caption p, .b_snippet, [class*="caption"]')?.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();
      items.push({ title, url: href, snippet });
    }
    return items;
  }, Math.min(Math.max(limit, 15), 25));

  return normalizeExtractorResults(query, Array.isArray(raw) ? raw : [], limit, languageContext);
}

export function buildBingSearchUrl(query, limit = 10, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  const hints = languageContext.hints.bing;
  const url = new URL(BING_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(Math.max(limit, 10), 20)));
  url.searchParams.set('setLang', hints.setLang || 'en');
  url.searchParams.set('mkt', hints.mkt || 'en-US');
  return url;
}

export async function searchBing(query, limit = 10, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  return withBrowserPage(async (page) => {
    const url = buildBingSearchUrl(query, limit, languageContext);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    await page.waitForSelector('li.b_algo h2 a', { timeout: 5000 }).catch(() => {});

    await page.evaluate(() => {
      const btn = document.querySelector('#bnp_btn_accept, button[id*="accept"]');
      if (btn) btn.click();
    });

    const extracted = await extractSerpResults(page, { ...BING_EXTRACT_CONFIG, query, limit: Math.min(Math.max(limit, 15), 25) });
    const terminal = handleExtractionStatus(extracted);
    if (terminal !== null) return terminal;

    const results = normalizeExtractorResults(query, extracted.results || [], limit, languageContext);
    if (results.length > 0) return results;
    if (extracted.status === 'ok' || extracted.status === 'partial') {
      const fallback = await fallbackExtractBingResults(page, query, limit, languageContext);
      if (fallback.length > 0) return fallback;
      throw providerError('Bing selector_miss: extractor and fallback returned zero results', {
        provider: 'bing',
        code: 'selector_miss',
        state: 'empty_suspect',
        retryable: true,
        degradation: true,
      });
    }
    return results;
  });
}

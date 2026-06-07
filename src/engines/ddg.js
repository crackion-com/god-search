import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';
import { extractSerpResults } from '../extraction/serp-extractor.js';
import { buildLanguageContext } from '../language.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_EXTRACT_CONFIG = {
  engine: 'ddg',
  engineHostnames: ['duckduckgo.com', 'html.duckduckgo.com'],
  primarySelectors: {
    result: ['.result:not(.result--ad)', '.web-result'],
    title: ['.result__title a', 'a.result__a'],
    link: ['.result__title a[href]', 'a.result__a[href]'],
    snippet: ['.result__snippet', 'a.result__snippet'],
  },
  redirectRules: [{ hostnames: ['duckduckgo.com', 'html.duckduckgo.com'], params: ['uddg'] }],
  adSignals: ['result--ad', 'sponsored', 'advertisement'],
  blockedSignals: ['checking your browser', 'unusual traffic', 'enable javascript'],
  consentSignals: ['duckduckgo privacy'],
  noResultSignals: ['no results', 'not many results contain'],
};

let _challengeCooldown = 0;

function decodeDdgUrl(rawUrl) {
  let url = rawUrl || '';
  try {
    const parsed = new URL(url, DDG_HTML_URL);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) url = decodeURIComponent(uddg);
    if (parsed.hostname === 'duckduckgo.com' && !uddg) url = '';
  } catch {}
  return url;
}

function normalizeExtractorResults(query, results, limit, languageContext) {
  return results
    .map(r => ({ ...r, url: decodeDdgUrl(r.url || '') }))
    .filter(r => r.title && r.url?.startsWith('http'))
    .map(r => ({
      title: r.title,
      url: r.url,
      snippet: (r.snippet || '').slice(0, 300),
      score: scoreResult(query, r.url, r.title, r.snippet || '', languageContext),
      domain: registrableDomain(r.url),
      engine: 'ddg',
    }))
    .slice(0, limit);
}

function handleExtractionStatus(extracted) {
  if (extracted.status === 'empty') return [];
  if (extracted.status === 'blocked') {
    _challengeCooldown = Date.now() + 30_000;
    throw new Error('DDG challenge page — 30s cooldown');
  }
  if (extracted.status === 'consent') {
    throw new Error('DDG consent page prevented result extraction');
  }
  if (extracted.status === 'failed') {
    const reason = extracted.diagnostics?.reason || extracted.diagnostics?.error || 'unknown extractor failure';
    throw new Error(`DDG extraction failed: ${reason}`);
  }
  return null;
}

export function buildDdgSearchUrl(query, _limit = 10, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  const url = new URL(DDG_HTML_URL);
  url.searchParams.set('q', query);
  if (languageContext.hints.ddg.kl) url.searchParams.set('kl', languageContext.hints.ddg.kl);
  return url;
}

export async function searchDdg(query, limit = 10, context = {}) {
  if (Date.now() < _challengeCooldown) throw new Error('DDG in CAPTCHA cooldown');

  const languageContext = buildLanguageContext(query, context);
  return withBrowserPage(async (page) => {
    const url = buildDdgSearchUrl(query, limit, languageContext);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    const extracted = await extractSerpResults(page, { ...DDG_EXTRACT_CONFIG, query, limit: Math.min(Math.max(limit, 15), 25) });
    const terminal = handleExtractionStatus(extracted);
    if (terminal !== null) return terminal;

    return normalizeExtractorResults(query, extracted.results || [], limit, languageContext);
  });
}

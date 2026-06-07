import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';
import { extractSerpResults } from '../extraction/serp-extractor.js';
import { buildLanguageContext } from '../language.js';

const GOOGLE_URL = 'https://www.google.com/search';
const GOOGLE_EXTRACT_CONFIG = {
  engine: 'google',
  engineHostnames: ['google.com', 'www.google.com'],
  primarySelectors: {
    result: ['div#search div.g', 'div[data-hveid][data-ved]:not([data-rw])'],
    title: ['h3'],
    link: ['a[href]'],
    snippet: ['[data-sncf]', '.VwiC3b', 'span.st', '[data-content-feature]', 'div[style] > span'],
  },
  adSignals: ['sponsored', 'advertisement'],
  blockedSignals: ['unusual traffic', 'automated queries', 'CaptchaRedirect'],
  consentSignals: ['google cookies'],
  noResultSignals: ['did not match any documents', 'no results found'],
};

let _challengeCooldown = 0;

function normalizeExtractorResults(query, results, limit, languageContext) {
  return results
    .filter(r => {
      if (!r.title || !r.url?.startsWith('http')) return false;
      try {
        const url = new URL(r.url);
        if (/(\.|^)accounts\.google\.com$/i.test(url.hostname)) return false;
        if (/(\.|^)support\.google\.com$/i.test(url.hostname)) return false;
        return !/(\.|^)google\.com$/i.test(url.hostname) || !url.pathname.startsWith('/search');
      } catch {
        return false;
      }
    })
    .map(r => ({
      title: r.title,
      url: r.url,
      snippet: (r.snippet || '').slice(0, 300),
      score: scoreResult(query, r.url, r.title, r.snippet || '', languageContext),
      domain: registrableDomain(r.url),
      engine: 'google',
    }))
    .slice(0, limit);
}

function handleExtractionStatus(extracted) {
  if (extracted.status === 'empty') return [];
  if (extracted.status === 'blocked') {
    _challengeCooldown = Date.now() + 30_000;
    throw new Error('Google challenge page — 30s cooldown');
  }
  if (extracted.status === 'consent') {
    throw new Error('Google consent page prevented result extraction');
  }
  if (extracted.status === 'failed') {
    const reason = extracted.diagnostics?.reason || extracted.diagnostics?.error || 'unknown extractor failure';
    throw new Error(`Google extraction failed: ${reason}`);
  }
  return null;
}

export function buildGoogleSearchUrl(query, limit = 10, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  const hints = languageContext.hints.google;
  const url = new URL(GOOGLE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(Math.max(limit, 10), 20)));
  url.searchParams.set('hl', hints.hl || 'en');
  if (hints.lr) url.searchParams.set('lr', hints.lr);
  if (hints.gl) url.searchParams.set('gl', hints.gl);
  return url;
}

export async function searchGoogle(query, limit = 10, context = {}) {
  if (Date.now() < _challengeCooldown) throw new Error('Google in CAPTCHA cooldown');

  const languageContext = buildLanguageContext(query, context);
  return withBrowserPage(async (page) => {
    const url = buildGoogleSearchUrl(query, limit, languageContext);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    await page.evaluate(() => {
      const btn = document.querySelector('button[id*="accept"], button[aria-label*="Accept all"]');
      if (btn) btn.click();
    });

    const extracted = await extractSerpResults(page, { ...GOOGLE_EXTRACT_CONFIG, query, limit: Math.min(Math.max(limit, 15), 25) });
    const terminal = handleExtractionStatus(extracted);
    if (terminal !== null) return terminal;

    return normalizeExtractorResults(query, extracted.results || [], limit, languageContext);
  });
}

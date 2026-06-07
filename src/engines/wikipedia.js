/**
 * engines/wikipedia.js — Wikipedia via public MediaWiki API (no browser needed)
 * Two-step: search → fetch extracts. Skip disambiguation pages.
 */

import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';
import { buildLanguageContext } from '../language.js';

const USER_AGENT = 'god-search/1.0 (research tool)';
const WIKI_MIN_INTERVAL_MS = 750;
const WIKI_429_COOLDOWN_MS = 2 * 60 * 1000;

let wikiRequestQueue = Promise.resolve();
let wikiLastRequestAt = 0;
let wikiCooldownUntil = 0;
let wikiCooldownStatus = null;

export function __resetForTests() {
  wikiRequestQueue = Promise.resolve();
  wikiLastRequestAt = 0;
  wikiCooldownUntil = 0;
  wikiCooldownStatus = null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);

  return null;
}

function formatDuration(ms) {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

function assertWikiAvailable() {
  const remaining = wikiCooldownUntil - Date.now();
  if (remaining > 0) {
    throw new Error(`Wikipedia API: cooldown active after HTTP ${wikiCooldownStatus}; retry after ${formatDuration(remaining)}`);
  }
}

function activateWikiCooldown(resp) {
  const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
  const cooldownMs = Math.max(1000, retryAfter ?? WIKI_429_COOLDOWN_MS);
  wikiCooldownStatus = resp.status;
  wikiCooldownUntil = Date.now() + cooldownMs;
  return cooldownMs;
}

function clearWikiCooldown() {
  wikiCooldownUntil = 0;
  wikiCooldownStatus = null;
}

async function fetchJsonNow(url) {
  assertWikiAvailable();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (resp.status === 429) {
      const cooldownMs = activateWikiCooldown(resp);
      throw new Error(`Wikipedia API: HTTP 429; cooling down for ${formatDuration(cooldownMs)}`);
    }
    if (!resp.ok) throw new Error(`Wikipedia API: HTTP ${resp.status}`);
    clearWikiCooldown();
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const run = wikiRequestQueue.then(async () => {
    assertWikiAvailable();

    const delayMs = wikiLastRequestAt + WIKI_MIN_INTERVAL_MS - Date.now();
    if (delayMs > 0) await sleep(delayMs);

    assertWikiAvailable();
    wikiLastRequestAt = Date.now();

    return fetchJsonNow(url);
  });

  wikiRequestQueue = run.catch(() => {});
  return run;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildWikipediaSearchUrl(query, limit = 5, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  const searchUrl = new URL(languageContext.hints.wikipedia.api);
  searchUrl.searchParams.set('action', 'query');
  searchUrl.searchParams.set('list', 'search');
  searchUrl.searchParams.set('srsearch', query);
  searchUrl.searchParams.set('srlimit', String(Math.min(limit + 3, 10)));
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('origin', '*');
  searchUrl.searchParams.set('uselang', languageContext.hints.wikipedia.uselang);
  return searchUrl;
}

function buildWikipediaExtractUrl(pageIds, context = {}) {
  const languageContext = buildLanguageContext('', context);
  const extractUrl = new URL(languageContext.hints.wikipedia.api);
  extractUrl.searchParams.set('action', 'query');
  extractUrl.searchParams.set('pageids', pageIds);
  extractUrl.searchParams.set('prop', 'extracts|info');
  extractUrl.searchParams.set('exintro', 'true');
  extractUrl.searchParams.set('explaintext', 'true');
  extractUrl.searchParams.set('exlimit', 'max');
  extractUrl.searchParams.set('inprop', 'url');
  extractUrl.searchParams.set('format', 'json');
  extractUrl.searchParams.set('origin', '*');
  extractUrl.searchParams.set('uselang', languageContext.hints.wikipedia.uselang);
  return extractUrl;
}

export async function searchWikipedia(query, limit = 5, context = {}) {
  const languageContext = buildLanguageContext(query, context);
  // Step 1: search for page titles
  const searchUrl = buildWikipediaSearchUrl(query, limit, languageContext);

  const searchData = await fetchJson(searchUrl.toString());
  const searchResults = searchData?.query?.search;
  if (!Array.isArray(searchResults) || searchResults.length === 0) return [];

  const pageIds = searchResults.map(r => r.pageid).join('|');

  // Step 2: fetch intro extracts
  const extractUrl = buildWikipediaExtractUrl(pageIds, languageContext);

  const extractData = await fetchJson(extractUrl.toString());
  const pages = extractData?.query?.pages ?? {};

  const results = [];

  for (const sr of searchResults) {
    if (results.length >= limit) break;
    const page = pages[sr.pageid];
    if (!page || page.missing) continue;

    const extract = page.extract || '';

    // Skip disambiguation pages
    if (extract.toLowerCase().includes('may refer to:') && extract.length < 500) continue;
    if (page.title?.endsWith('(disambiguation)')) continue;

    const pageUrl = page.fullurl || `https://${languageContext.hints.wikipedia.language}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
    const title = page.title || sr.title;
    const snippet = stripHtml(extract).slice(0, 300);

    results.push({
      title,
      url: pageUrl,
      snippet,
      score: scoreResult(query, pageUrl, title, snippet, languageContext),
      domain: registrableDomain(pageUrl),
      engine: 'wikipedia',
    });
  }

  return results;
}

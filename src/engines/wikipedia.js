/**
 * engines/wikipedia.js — Wikipedia via public MediaWiki API (no browser needed)
 * Two-step: search → fetch extracts. Skip disambiguation pages.
 */

import { scoreResult, registrableDomain } from '../scoring.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'god-search/1.0 (research tool)';
const TIMEOUT_MS = 8000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Wikipedia API: HTTP ${resp.status}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function searchWikipedia(query, limit = 5) {
  // Step 1: search for page titles
  const searchUrl = new URL(WIKI_API);
  searchUrl.searchParams.set('action', 'query');
  searchUrl.searchParams.set('list', 'search');
  searchUrl.searchParams.set('srsearch', query);
  searchUrl.searchParams.set('srlimit', String(Math.min(limit + 3, 10)));
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('origin', '*');

  const searchData = await fetchJson(searchUrl.toString());
  const searchResults = searchData?.query?.search;
  if (!Array.isArray(searchResults) || searchResults.length === 0) return [];

  const pageIds = searchResults.map(r => r.pageid).join('|');

  // Step 2: fetch intro extracts
  const extractUrl = new URL(WIKI_API);
  extractUrl.searchParams.set('action', 'query');
  extractUrl.searchParams.set('pageids', pageIds);
  extractUrl.searchParams.set('prop', 'extracts|info');
  extractUrl.searchParams.set('exintro', 'true');
  extractUrl.searchParams.set('explaintext', 'true');
  extractUrl.searchParams.set('exlimit', 'max');
  extractUrl.searchParams.set('inprop', 'url');
  extractUrl.searchParams.set('format', 'json');
  extractUrl.searchParams.set('origin', '*');

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

    const pageUrl = page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
    const title = page.title || sr.title;
    const snippet = stripHtml(extract).slice(0, 300);

    results.push({
      title,
      url: pageUrl,
      snippet,
      score: scoreResult(query, pageUrl, title, snippet),
      domain: registrableDomain(pageUrl),
      engine: 'wikipedia',
    });
  }

  return results;
}

/**
 * engines/hackernews.js — Hacker News via public Algolia API.
 *
 * No API key is required. Use sparingly for discussion/fresh tech queries.
 */

import { SEARCH_CONFIG } from '../config.js';
import { scoreResult, registrableDomain } from '../scoring.js';

const HN_SEARCH = 'https://hn.algolia.com/api/v1/search';
const HN_SEARCH_BY_DATE = 'https://hn.algolia.com/api/v1/search_by_date';
const USER_AGENT = 'god-search/1.0 (research tool)';
const HN_SIGNAL_RE = /\b(hacker\s*news|hn|show hn|ask hn|launch|startup|discussion|thread|recent|latest|new|newest)\b/i;
const FRESHNESS_RE = /\b(latest|recent|new|newest|today|this week|this month|launch|launched|show hn)\b/i;
const LOW_VALUE_RE = /\b(docs?|documentation|api reference|reference manual|specification|standard)\b/i;

let cooldownUntil = 0;
let cooldownReason = '';

export function __resetForTests() {
  cooldownUntil = 0;
  cooldownReason = '';
}

function hnError(message, {
  state = 'failed',
  code = state,
  status = null,
  retryAfterMs = null,
} = {}) {
  const err = new Error(message);
  err.provider = 'hackernews';
  err.state = state;
  err.code = code;
  err.status = status;
  err.degradation = true;
  if (retryAfterMs != null) err.retry_after_ms = retryAfterMs;
  return err;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function activateCooldown(reason, retryAfterMs = 60_000) {
  cooldownReason = reason;
  cooldownUntil = Date.now() + Math.max(1000, retryAfterMs);
  return cooldownUntil - Date.now();
}

function assertAvailable() {
  const remaining = cooldownUntil - Date.now();
  if (remaining > 0) {
    throw hnError(`Hacker News API: cooldown active after ${cooldownReason}; retry after ${Math.ceil(remaining / 1000)}s`, {
      state: 'cooldown',
      code: 'cooldown',
      retryAfterMs: remaining,
    });
  }
}

function shouldSkipHn(query) {
  if (/\b(hacker\s*news|hn|show hn|ask hn)\b/i.test(query)) return false;
  if (LOW_VALUE_RE.test(query)) return true;
  return !HN_SIGNAL_RE.test(query);
}

function itemUrl(item) {
  if (item.url && /^https?:\/\//i.test(item.url)) return item.url;
  if (item.objectID) return `https://news.ycombinator.com/item?id=${encodeURIComponent(item.objectID)}`;
  return '';
}

function itemSnippet(item) {
  const parts = [];
  if (item.author) parts.push(`by ${item.author}`);
  if (Number.isFinite(item.points)) parts.push(`${item.points} points`);
  if (Number.isFinite(item.num_comments)) parts.push(`${item.num_comments} comments`);
  if (item.created_at) parts.push(item.created_at.slice(0, 10));
  return parts.join(' · ') || 'Hacker News discussion';
}

function itemBoost(item) {
  let boost = 0;
  if (Number.isFinite(item.points) && item.points > 0) boost += Math.min(Math.floor(Math.log10(item.points + 1)) + 1, 4);
  if (Number.isFinite(item.num_comments) && item.num_comments > 0) boost += Math.min(Math.floor(Math.log10(item.num_comments + 1)) + 1, 4);
  return boost;
}

export async function searchHackerNews(query, limit = 10) {
  if (shouldSkipHn(query)) return [];
  assertAvailable();

  const endpoint = FRESHNESS_RE.test(query) ? HN_SEARCH_BY_DATE : HN_SEARCH;
  const url = new URL(endpoint);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', String(Math.min(limit + 5, 30)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (resp.status === 429) {
      const retryAfterMs = activateCooldown('HTTP 429', parseRetryAfter(resp.headers.get('retry-after')) || 60_000);
      throw hnError('Hacker News API: HTTP 429 rate limited', {
        state: 'rate_limited',
        code: 'rate_limited',
        status: 429,
        retryAfterMs,
      });
    }
    if (!resp.ok) throw hnError(`Hacker News API: HTTP ${resp.status}`, { status: resp.status });
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(data?.hits)) {
    throw hnError('Hacker News API: unexpected response shape');
  }

  const seen = new Set();
  const results = [];
  for (const item of data.hits) {
    if (results.length >= limit) break;
    const url = itemUrl(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const title = item.title || item.story_title || '';
    if (!title) continue;
    const snippet = itemSnippet(item);
    results.push({
      title,
      url,
      snippet,
      score: scoreResult(query, url, title, snippet) + itemBoost(item),
      domain: registrableDomain(url),
      engine: 'hackernews',
      sourceRank: results.length + 1,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

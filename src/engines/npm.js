/**
 * engines/npm.js — npm package search via public registry API.
 *
 * No API key is required. This is routed only for package/library-shaped
 * developer queries.
 */

import { SEARCH_CONFIG } from '../config.js';
import { scoreResult, registrableDomain } from '../scoring.js';

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const USER_AGENT = 'god-search/1.0 (research tool)';
const PACKAGE_SIGNAL_RE = /\b(npm|package|packages|node|nodejs|javascript|typescript|react|vite|webpack|eslint|library|module|install|plugin|sdk)\b/i;
const EXPLICIT_PACKAGE_SIGNAL_RE = /\b(npm|package|packages)\b/i;
const DOCS_RESOURCE_QUERY_RE = /\b(docs?|documentation|api|reference|handbook|manual|tutorial|guide)\b/i;
const LOW_VALUE_RE = /^(what is|who is|define|definition of|history of|list of)\b/i;

let cooldownUntil = 0;
let cooldownReason = '';

export function __resetForTests() {
  cooldownUntil = 0;
  cooldownReason = '';
}

function npmError(message, {
  state = 'failed',
  code = state,
  status = null,
  retryAfterMs = null,
} = {}) {
  const err = new Error(message);
  err.provider = 'npm';
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
    throw npmError(`npm registry: cooldown active after ${cooldownReason}; retry after ${Math.ceil(remaining / 1000)}s`, {
      state: 'cooldown',
      code: 'cooldown',
      retryAfterMs: remaining,
    });
  }
}

function shouldSkipNpm(query) {
  if (LOW_VALUE_RE.test(query)) return true;
  if (DOCS_RESOURCE_QUERY_RE.test(query) && !EXPLICIT_PACKAGE_SIGNAL_RE.test(query)) return true;
  return !PACKAGE_SIGNAL_RE.test(query);
}

function packageUrl(pkg) {
  const name = pkg?.name;
  return name ? `https://www.npmjs.com/package/${encodeURIComponent(name)}` : '';
}

function packageSnippet(item) {
  const pkg = item.package || {};
  const score = item.score || {};
  const detail = score.detail || {};
  const parts = [
    pkg.description || '',
    pkg.version ? `v${pkg.version}` : '',
    pkg.publisher?.username ? `by ${pkg.publisher.username}` : '',
    Number.isFinite(detail.popularity) ? `popularity ${detail.popularity.toFixed(2)}` : '',
    Number.isFinite(detail.quality) ? `quality ${detail.quality.toFixed(2)}` : '',
    Number.isFinite(detail.maintenance) ? `maintenance ${detail.maintenance.toFixed(2)}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function packageBoost(item) {
  const score = item.score || {};
  const detail = score.detail || {};
  let boost = 0;
  if (Number.isFinite(score.final)) boost += Math.min(score.final * 8, 8);
  if (Number.isFinite(detail.quality)) boost += Math.min(detail.quality * 3, 3);
  if (Number.isFinite(detail.popularity)) boost += Math.min(detail.popularity * 2, 2);
  if (Number.isFinite(detail.maintenance)) boost += Math.min(detail.maintenance * 2, 2);
  return boost;
}

export async function searchNpm(query, limit = 10) {
  if (shouldSkipNpm(query)) return [];
  assertAvailable();

  const url = new URL(NPM_SEARCH);
  url.searchParams.set('text', query);
  url.searchParams.set('size', String(Math.min(limit + 5, 30)));
  url.searchParams.set('from', '0');
  url.searchParams.set('quality', '0.35');
  url.searchParams.set('popularity', '0.45');
  url.searchParams.set('maintenance', '0.20');

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
      throw npmError('npm registry: HTTP 429 rate limited', {
        state: 'rate_limited',
        code: 'rate_limited',
        status: 429,
        retryAfterMs,
      });
    }
    if (!resp.ok) throw npmError(`npm registry: HTTP ${resp.status}`, { status: resp.status });
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(data?.objects)) {
    throw npmError('npm registry: unexpected response shape');
  }

  const seen = new Set();
  const results = [];
  for (const item of data.objects) {
    if (results.length >= limit) break;
    const pkg = item.package || {};
    const url = packageUrl(pkg);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const title = pkg.name || '';
    const snippet = packageSnippet(item);
    results.push({
      title,
      url,
      snippet,
      score: scoreResult(query, url, title, snippet) + packageBoost(item),
      domain: registrableDomain(url),
      engine: 'npm',
      sourceRank: results.length + 1,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

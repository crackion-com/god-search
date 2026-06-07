/**
 * engines/stackoverflow.js — Stack Overflow via public Stack Exchange API.
 *
 * No API key is required. The API may return a backoff hint or quota errors;
 * callers treat those as typed provider degradation.
 */

import { SEARCH_CONFIG } from '../config.js';
import { scoreResult, registrableDomain } from '../scoring.js';

const STACK_EXCHANGE_SEARCH = 'https://api.stackexchange.com/2.3/search/advanced';
const STACK_OVERFLOW_HOST = 'stackoverflow.com';
const USER_AGENT = 'god-search/1.0 (research tool)';
const DOCS_RESOURCE_QUERY_RE = /\b(docs?|documentation|api|reference|handbook|manual|tutorial|sdk)\b/i;
const FACTUAL_QUERY_RE = /^(what is|who is|define|definition of|history of|list of)\b/i;
const STACK_OVERFLOW_SIGNAL_RE = /\b(stack\s*overflow|stackoverflow|stackexchange|stack\s*exchange|error|exception|traceback|debug|bug|fix|issue|problem|question|answer)\b/i;

let stackOverflowCooldownUntil = 0;
let stackOverflowCooldownReason = '';

export function __resetForTests() {
  stackOverflowCooldownUntil = 0;
  stackOverflowCooldownReason = '';
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDuration(ms) {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

function stackOverflowError(message, {
  state = 'failed',
  code = state,
  status = null,
  retryAfterMs = null,
} = {}) {
  const err = new Error(message);
  err.provider = 'stackoverflow';
  err.state = state;
  err.code = code;
  err.status = status;
  err.degradation = true;
  if (retryAfterMs != null) err.retry_after_ms = retryAfterMs;
  return err;
}

function assertStackOverflowAvailable() {
  const remaining = stackOverflowCooldownUntil - Date.now();
  if (remaining > 0) {
    throw stackOverflowError(
      `Stack Overflow API: cooldown active${stackOverflowCooldownReason ? ` after ${stackOverflowCooldownReason}` : ''}; retry after ${formatDuration(remaining)}`,
      { state: 'cooldown', code: 'cooldown', retryAfterMs: remaining },
    );
  }
}

function activateStackOverflowCooldown(reason, seconds) {
  const retryAfterMs = Math.max(1000, Number(seconds || 0) * 1000);
  stackOverflowCooldownReason = reason;
  stackOverflowCooldownUntil = Date.now() + retryAfterMs;
  return retryAfterMs;
}

function shouldSkipPublicStackOverflowNetwork(query) {
  if (/\b(stack\s*overflow|stackoverflow|stackexchange|stack\s*exchange)\b/i.test(query)) return false;
  return !STACK_OVERFLOW_SIGNAL_RE.test(query) ||
    DOCS_RESOURCE_QUERY_RE.test(query) ||
    FACTUAL_QUERY_RE.test(query);
}

function questionUrl(item) {
  if (item.link) return item.link;
  if (item.question_id) return `https://stackoverflow.com/questions/${item.question_id}`;
  return '';
}

function questionSnippet(item) {
  const parts = ['Stack Overflow question'];
  if (Array.isArray(item.tags) && item.tags.length) parts.push(`tags: ${item.tags.slice(0, 5).join(', ')}`);
  if (Number.isFinite(item.score)) parts.push(`score ${item.score}`);
  if (Number.isFinite(item.answer_count)) parts.push(`${item.answer_count} answers`);
  if (item.is_answered) parts.push(item.accepted_answer_id ? 'accepted answer' : 'answered');
  return parts.join(' · ');
}

function questionBoost(item) {
  let boost = 0;
  if (item.is_answered) boost += 4;
  if (item.accepted_answer_id) boost += 4;
  if (Number.isFinite(item.answer_count)) boost += Math.min(item.answer_count, 4);
  if (Number.isFinite(item.score) && item.score > 0) boost += Math.min(Math.floor(Math.log10(item.score + 1)) + 1, 4);
  return boost;
}

export async function searchStackOverflow(query, limit = 10) {
  if (shouldSkipPublicStackOverflowNetwork(query)) return [];
  assertStackOverflowAvailable();

  const url = new URL(STACK_EXCHANGE_SEARCH);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('site', 'stackoverflow');
  url.searchParams.set('q', query);
  url.searchParams.set('pagesize', String(Math.min(limit + 5, 30)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    if (resp.status === 429) {
      throw stackOverflowError('Stack Overflow API: HTTP 429 rate limited', {
        state: 'rate_limited',
        code: 'rate_limited',
        status: 429,
      });
    }
    if (!resp.ok) throw stackOverflowError(`Stack Overflow API: HTTP ${resp.status}`, { status: resp.status });
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (data?.error_id) {
    const retryAfterMs = data.backoff ? activateStackOverflowCooldown(data.error_name || `error ${data.error_id}`, data.backoff) : null;
    throw stackOverflowError(`Stack Overflow API: ${data.error_name || 'error'} (${data.error_id})`, {
      state: data.error_name === 'throttle_violation' || data.error_name === 'access_token_required' ? 'rate_limited' : 'failed',
      code: data.error_name || 'failed',
      retryAfterMs,
    });
  }

  if (data?.backoff) {
    activateStackOverflowCooldown('backoff', data.backoff);
  }

  if (!Array.isArray(data?.items)) {
    throw stackOverflowError('Stack Overflow API: unexpected response shape');
  }

  const results = [];
  const seen = new Set();
  for (const item of data.items) {
    if (results.length >= limit) break;
    const itemUrl = questionUrl(item);
    if (!itemUrl || seen.has(itemUrl)) continue;
    seen.add(itemUrl);

    const title = htmlDecode(item.title);
    const snippet = questionSnippet(item);
    results.push({
      title,
      url: itemUrl,
      snippet,
      score: scoreResult(query, itemUrl, title, snippet) + questionBoost(item),
      domain: registrableDomain(itemUrl) || STACK_OVERFLOW_HOST,
      engine: 'stackoverflow',
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * engines/reddit.js — Reddit via public JSON API (no browser needed)
 */

import { scoreResult, registrableDomain } from '../scoring.js';
import { REDDIT_CONFIG, SEARCH_CONFIG } from '../config.js';
import { providerError } from '../provider-errors.js';

const REDDIT_PUBLIC_SEARCH = 'https://www.reddit.com/search.json';
const REDDIT_OAUTH_SEARCH = 'https://oauth.reddit.com/search';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_403_COOLDOWN_MS = 15 * 60 * 1000;
const REDDIT_429_COOLDOWN_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DISCUSSION_QUERY_RE = /\b(reddit|discussion|forum|thread|threads|opinion|opinions|community|communities|compare|comparison|vs\.?|versus|best)\b/i;
const NON_REDDIT_RESOURCE_QUERY_RE = /\b(github|gitlab|repo|repos|repository|repositories|source code|implementation|implementations|docs?|documentation|api|reference|handbook|manual|tutorial|library|sdk)\b/i;
const FACTUAL_QUERY_RE = /^(what is|who is|define|definition of|history of|list of)\b/i;
const REDDIT_QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'best',
  'compare',
  'comparison',
  'discussion',
  'discussions',
  'forum',
  'forums',
  'for',
  'in',
  'of',
  'opinion',
  'opinions',
  'or',
  'reddit',
  'subreddit',
  'subreddits',
  'the',
  'thread',
  'threads',
  'to',
  'versus',
  'vs',
]);
const SUBREDDIT_TOKEN_ALIASES = new Map([
  ['postgres', 'PostgreSQL'],
  ['postgresql', 'PostgreSQL'],
  ['sqlite', 'sqlite'],
  ['llm', 'LLaMA'],
  ['llms', 'LLaMA'],
]);
const COMPARISON_QUERY_RE = /\b(compare|comparison|vs\.?|versus)\b/i;

let redditCooldownUntil = 0;
let redditCooldownStatus = null;
let redditOAuthToken = null;
let redditOAuthTokenPromise = null;

export function __resetForTests() {
  redditCooldownUntil = 0;
  redditCooldownStatus = null;
  redditOAuthToken = null;
  redditOAuthTokenPromise = null;
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

function redditCooldownRemaining() {
  return redditCooldownUntil - Date.now();
}

function assertRedditAvailable() {
  const remaining = redditCooldownRemaining();
  if (remaining > 0) {
    throw providerError(`Reddit API: cooldown active after HTTP ${redditCooldownStatus}; retry after ${formatDuration(remaining)}`, {
      provider: 'reddit',
      code: 'cooldown',
      state: 'cooldown',
      status: redditCooldownStatus,
      retryAfterMs: remaining,
      retryable: true,
      degradation: true,
    });
  }
}

function cleanDiscussionTokens(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !REDDIT_QUERY_STOP_WORDS.has(token));
}

function subredditTokenPart(token) {
  const alias = SUBREDDIT_TOKEN_ALIASES.get(token);
  if (alias) return alias;
  if (/^[a-z]*[0-9][a-z0-9]*$/.test(token)) return token.toUpperCase();
  return `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`;
}

function shouldPluralizePhrase(tokens) {
  const last = tokens.at(-1);
  return last && !SUBREDDIT_TOKEN_ALIASES.has(last) && !last.endsWith('s');
}

function addRedditResult(results, seen, query, title, url, snippet) {
  if (seen.has(url)) return;
  seen.add(url);
  results.push({
    title,
    url,
    snippet: snippet.slice(0, 300),
    score: scoreResult(query, url, title, snippet),
    domain: registrableDomain(url),
    engine: 'reddit',
  });
}

function addSubredditCandidates(results, seen, query, displayName, sourceSnippet = '') {
  const subreddit = String(displayName || '').replace(/^r\//i, '').trim();
  if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) return;

  const title = `r/${subreddit}`;
  const snippet = sourceSnippet || `Reddit community and discussions for ${subreddit}`;
  addRedditResult(results, seen, query, title, `https://www.reddit.com/r/${subreddit}`, snippet);
  addRedditResult(results, seen, query, `${title} search`, `https://www.reddit.com/r/${subreddit}/search`, `Search ${title} discussions`);
}

function buildQuerySubredditCandidates(query, limit) {
  if (!DISCUSSION_QUERY_RE.test(query)) return [];

  const tokens = cleanDiscussionTokens(query);
  if (!tokens.length) return [];

  const results = [];
  const seen = new Set();
  const candidates = [];

  const lengths = tokens.length === 2 && COMPARISON_QUERY_RE.test(query)
    ? [1]
    : [2, 1, 3].filter(length => length <= tokens.length);

  for (const length of lengths) {
    for (let start = 0; start <= tokens.length - length; start += 1) {
      const phraseTokens = tokens.slice(start, start + length);
      const candidate = phraseTokens.map(subredditTokenPart).join('');
      if (!candidate || candidates.includes(candidate)) continue;
      if (length > 1 && shouldPluralizePhrase(phraseTokens)) {
        candidates.push(`${candidate}s`);
      }
      candidates.push(candidate);
    }
  }

  for (const candidate of candidates) {
    if (results.length >= limit) break;
    addSubredditCandidates(results, seen, query, candidate, `Reddit discussions for ${tokens.join(' ')}`);
  }

  if (results.length < limit) {
    const searchUrl = new URL('https://www.reddit.com/search');
    searchUrl.searchParams.set('q', tokens.join(' '));
    addRedditResult(
      results,
      seen,
      query,
      `Reddit search: ${tokens.join(' ')}`,
      searchUrl.toString(),
      `Search Reddit discussions for ${tokens.join(' ')}`,
    );
  }

  return results.slice(0, limit);
}

function shouldSkipPublicRedditNetwork(query) {
  if (redditAuthMode() !== 'public') return false;
  if (DISCUSSION_QUERY_RE.test(query)) return false;
  return NON_REDDIT_RESOURCE_QUERY_RE.test(query) || FACTUAL_QUERY_RE.test(query);
}

function activateRedditCooldown(resp) {
  const fallback = resp.status === 403 ? REDDIT_403_COOLDOWN_MS : REDDIT_429_COOLDOWN_MS;
  const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
  const cooldownMs = Math.max(1000, retryAfter ?? fallback);
  redditCooldownStatus = resp.status;
  redditCooldownUntil = Date.now() + cooldownMs;
  return cooldownMs;
}

function clearRedditCooldown() {
  redditCooldownUntil = 0;
  redditCooldownStatus = null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function redditAuthMode() {
  const hasClientId = REDDIT_CONFIG.clientId !== '';
  const hasClientSecret = REDDIT_CONFIG.clientSecret !== '';

  if (!hasClientId && !hasClientSecret) return 'public';
  if (hasClientId && hasClientSecret) return 'oauth';

  throw new Error('Reddit OAuth: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be set together');
}

async function fetchRedditOAuthToken() {
  assertRedditAvailable();

  const auth = Buffer
    .from(`${REDDIT_CONFIG.clientId}:${REDDIT_CONFIG.clientSecret}`)
    .toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const resp = await fetchWithTimeout(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_CONFIG.userAgent,
    },
    body,
  });

  if (resp.status === 403 || resp.status === 429) {
    const cooldownMs = activateRedditCooldown(resp);
    throw providerError(`Reddit OAuth: HTTP ${resp.status}; cooling down for ${formatDuration(cooldownMs)}`, {
      provider: 'reddit',
      code: 'cooldown',
      state: 'cooldown',
      status: resp.status,
      retryAfterMs: cooldownMs,
      retryable: true,
      degradation: true,
    });
  }
  if (!resp.ok) throw new Error(`Reddit OAuth: HTTP ${resp.status}`);
  clearRedditCooldown();

  const data = await resp.json();
  if (!data?.access_token) throw new Error('Reddit OAuth: unexpected token response shape');

  const expiresInMs = Math.max(0, Number(data.expires_in ?? 0) * 1000);
  redditOAuthToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  };

  return redditOAuthToken.accessToken;
}

async function getRedditOAuthToken() {
  if (
    redditOAuthToken?.accessToken &&
    redditOAuthToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return redditOAuthToken.accessToken;
  }

  if (!redditOAuthTokenPromise) {
    redditOAuthTokenPromise = fetchRedditOAuthToken().finally(() => {
      redditOAuthTokenPromise = null;
    });
  }

  return redditOAuthTokenPromise;
}

async function buildRedditRequestUrlAndHeaders(query, limit) {
  const mode = redditAuthMode();
  const url = new URL(mode === 'oauth' ? REDDIT_OAUTH_SEARCH : REDDIT_PUBLIC_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(limit + 5, 25)));
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('type', 'sr,link');

  const headers = { 'User-Agent': REDDIT_CONFIG.userAgent };
  if (mode === 'oauth') {
    headers.Authorization = `Bearer ${await getRedditOAuthToken()}`;
  }

  return { url, headers };
}

export async function searchReddit(query, limit = 10) {
  const fallbackResults = buildQuerySubredditCandidates(query, limit);
  if (shouldSkipPublicRedditNetwork(query)) return fallbackResults;
  if (fallbackResults.length && redditCooldownRemaining() > 0) return fallbackResults;

  assertRedditAvailable();

  let data;
  const { url, headers } = await buildRedditRequestUrlAndHeaders(query, limit);
  const resp = await fetchWithTimeout(url.toString(), { headers });

  if (resp.status === 403 || resp.status === 429) {
    const cooldownMs = activateRedditCooldown(resp);
    if (fallbackResults.length) return fallbackResults;
    throw providerError(`Reddit API: HTTP ${resp.status}; cooling down for ${formatDuration(cooldownMs)}`, {
      provider: 'reddit',
      code: 'cooldown',
      state: 'cooldown',
      status: resp.status,
      retryAfterMs: cooldownMs,
      retryable: true,
      degradation: true,
    });
  }
  if (!resp.ok) throw new Error(`Reddit API: HTTP ${resp.status}`);
  clearRedditCooldown();
  data = await resp.json();

  if (!Array.isArray(data?.data?.children)) {
    throw new Error('Reddit API: unexpected response shape');
  }

  const results = [];
  const seen = new Set();

  for (const result of fallbackResults) {
    if (results.length >= limit) break;
    addRedditResult(results, seen, query, result.title, result.url, result.snippet);
  }

  for (const child of data.data.children) {
    if (results.length >= limit) break;
    const post = child.data;
    if (!post) continue;

    if (child.kind === 't5' || post.display_name) {
      addSubredditCandidates(results, seen, query, post.display_name || post.display_name_prefixed, post.public_description || post.title || '');
      continue;
    }

    if (DISCUSSION_QUERY_RE.test(query) && post.subreddit) {
      addSubredditCandidates(results, seen, query, post.subreddit, `r/${post.subreddit} · ${post.score} points`);
      if (results.length >= limit) break;
    }

    // Build canonical URL
    const postUrl = post.url?.startsWith('http')
      ? post.url
      : `https://www.reddit.com${post.permalink}`;

    // For self-posts, prefer the reddit thread URL (has discussion)
    const resultUrl = post.is_self
      ? `https://www.reddit.com${post.permalink}`
      : postUrl;

    const title = post.title || '';
    // Combine selftext + subreddit for snippet context
    const selftext = (post.selftext || '').slice(0, 200);
    const snippet = selftext || `r/${post.subreddit} · ${post.score} points`;

    addRedditResult(results, seen, query, title, resultUrl, snippet);
  }

  return results;
}

/**
 * engines/github.js — GitHub via public REST API (no browser needed)
 * Rate limit: 10 req/min unauthenticated — enforced via sliding window.
 */

import { scoreResult, applyForkPenalty, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const GITHUB_SEARCH = 'https://api.github.com/search/repositories';
const GITHUB_WEB_SEARCH = 'https://github.com/search';
const USER_AGENT = 'god-search/1.0';
const RATE_LIMIT = 10; // requests per window
const WINDOW_MS = 60_000; // 1 minute
const SEARCH_INTENT_WORDS = new Set([
  'github',
  'gitlab',
  'repo',
  'repos',
  'repository',
  'repositories',
  'source',
  'code',
  'implementation',
  'implementations',
  'example',
  'examples',
  'sample',
  'samples',
]);
const REPO_NAME_NOISE_WORDS = new Set([
  'awesome',
  'demo',
  'docs',
  'documentation',
  'example',
  'examples',
  'guide',
  'manager',
  'rank',
  'starter',
  'template',
  'tutorial',
  'weekly',
]);
const DOCS_RESOURCE_QUERY_RE = /\b(docs?|documentation|api|reference|handbook|manual|tutorial|library|sdk)\b/i;
const FACTUAL_QUERY_RE = /^(what is|who is|define|definition of|history of|list of)\b/i;

// Sliding window rate limiter
const _timestamps = [];

export function __resetForTests() {
  _timestamps.length = 0;
}

function githubToken() {
  return SEARCH_CONFIG.githubToken || process.env.GITHUB_TOKEN || '';
}

function checkRateLimit() {
  if (githubToken()) return;
  const now = Date.now();
  // Remove entries outside the window
  while (_timestamps.length && _timestamps[0] < now - WINDOW_MS) {
    _timestamps.shift();
  }
  if (_timestamps.length >= RATE_LIMIT) {
    throw new Error(`GitHub rate limit: ${RATE_LIMIT} req/${WINDOW_MS / 1000}s unauthenticated`);
  }
  _timestamps.push(now);
}

function wantsGithubSearchFallback(query) {
  return /\b(github|gitlab|repo|repos|repository|repositories|source code)\b/i.test(query);
}

function shouldSkipPublicGithubNetwork(query) {
  if (githubToken()) return false;
  return !wantsGithubSearchFallback(query) ||
    DOCS_RESOURCE_QUERY_RE.test(query) ||
    FACTUAL_QUERY_RE.test(query);
}

export function normalizeGithubQuery(query) {
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .split(/[^a-z0-9_.-]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !SEARCH_INTENT_WORDS.has(token));

  return tokens.length ? tokens.join(' ') : String(query || '').trim();
}

function normalizedGithubText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .replace(/[._/-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactGithubText(value) {
  return normalizedGithubText(value).replace(/\s+/g, '');
}

function githubRankingTokens(value) {
  return normalizedGithubText(value)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !SEARCH_INTENT_WORDS.has(token));
}

function countExactTokenMatches(queryTokens, textTokens) {
  const textTokenSet = new Set(textTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokenSet.has(token)) matches += 1;
  }
  return matches;
}

function containsTokenPhrase(haystack, phrase) {
  return phrase.length > 0 && (` ${haystack} `).includes(` ${phrase} `);
}

function githubRepositoryRelevanceBoost(query, repo, title, description) {
  const githubQuery = normalizeGithubQuery(query);
  const queryTokens = githubRankingTokens(githubQuery);
  if (!queryTokens.length) return 0;

  const repoName = repo.name || (repo.full_name || '').split('/').pop() || '';
  const titleText = title || repo.full_name || repoName;
  const repoNameTokens = githubRankingTokens(repoName);
  const titleTokens = githubRankingTokens(titleText);
  const descriptionTokens = githubRankingTokens(description);
  const queryPhrase = normalizedGithubText(githubQuery);
  const queryCompact = compactGithubText(githubQuery);
  const repoNamePhrase = normalizedGithubText(repoName);
  const titlePhrase = normalizedGithubText(titleText);
  const descriptionPhrase = normalizedGithubText(description);

  let boost = 0;
  boost += countExactTokenMatches(queryTokens, repoNameTokens) * 10;
  boost += countExactTokenMatches(queryTokens, titleTokens) * 6;
  boost += countExactTokenMatches(queryTokens, descriptionTokens) * 3;

  if (queryTokens.every(token => repoNameTokens.includes(token))) boost += 14;
  if (queryTokens.every(token => repoNameTokens.includes(token))) {
    const extraRepoTokens = repoNameTokens.filter(token => !queryTokens.includes(token));
    boost += repoNameTokens.length === queryTokens.length ? 22 : Math.max(0, 10 - (extraRepoTokens.length * 4));
    if (extraRepoTokens.some(token => REPO_NAME_NOISE_WORDS.has(token))) boost -= 10;
  }
  if (queryTokens.every(token => titleTokens.includes(token))) boost += 8;
  if (repoNamePhrase === queryPhrase || compactGithubText(repoName) === queryCompact) boost += 30;
  if (containsTokenPhrase(titlePhrase, queryPhrase)) boost += 10;
  if (containsTokenPhrase(descriptionPhrase, queryPhrase)) boost += 8;

  return boost;
}

function githubRepositoryQualityBoost(repo) {
  let boost = 0;
  if (Number.isFinite(repo.size)) {
    if (repo.size < 32) boost -= 28;
    else if (repo.size >= 1000) boost += 4;
    else if (repo.size >= 100) boost += 2;
  }
  if (Number.isFinite(repo.forks_count) && repo.forks_count > 0) {
    boost += Math.min(Math.floor(Math.log10(repo.forks_count + 1)) + 1, 4);
  }
  if (repo.owner?.type === 'Organization') boost += 2;
  if (repo.has_discussions) boost += 2;
  if (repo.homepage) boost += 2;
  return boost;
}

function githubSearchFallback(query, githubQuery) {
  const webUrl = new URL(GITHUB_WEB_SEARCH);
  webUrl.searchParams.set('q', githubQuery);
  const title = `GitHub repository search: ${githubQuery}`;
  const snippet = `Browse repository results for ${githubQuery}`;
  const url = webUrl.toString();

  return {
    title,
    url,
    snippet,
    score: scoreResult(query, url, title, snippet) - 12,
    domain: 'github.com',
    engine: 'github',
  };
}

export async function searchGithub(query, limit = 10) {
  if (shouldSkipPublicGithubNetwork(query)) return [];

  checkRateLimit();

  const githubQuery = normalizeGithubQuery(query);
  const url = new URL(GITHUB_SEARCH);
  url.searchParams.set('q', `${githubQuery} in:name,description,readme`);
  url.searchParams.set('per_page', String(Math.min(limit + 5, 30)));
  url.searchParams.set('sort', 'best_match');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const token = githubToken();
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/vnd.github.v3+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const resp = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    });
    if (resp.status === 403) throw new Error('GitHub API: rate limited (403)');
    if (!resp.ok) throw new Error(`GitHub API: HTTP ${resp.status}`);
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(data?.items)) {
    throw new Error('GitHub API: unexpected response shape');
  }

  const results = [];
  const seen = new Set();

  if (wantsGithubSearchFallback(query)) {
    const fallback = githubSearchFallback(query, githubQuery);
    results.push(fallback);
    seen.add(fallback.url);
  }

  for (const repo of data.items) {
    if (results.length >= limit) break;
    if (!repo.html_url || seen.has(repo.html_url)) continue;
    seen.add(repo.html_url);

    const title = repo.full_name || repo.name || '';
    const description = repo.description || '';
    const topicsStr = (repo.topics || []).join(', ');
    const snippet = [
      description,
      topicsStr ? `Topics: ${topicsStr}` : '',
      `★ ${repo.stargazers_count}`,
    ].filter(Boolean).join(' · ').slice(0, 300);

    let score = scoreResult(query, repo.html_url, title, snippet);
    score += githubRepositoryRelevanceBoost(query, repo, title, description);
    // Penalize forks — they're usually noise
    if (repo.fork) score = applyForkPenalty(score);
    // Boost by star count (log scale, capped at +5)
    if (repo.stargazers_count > 0) {
      score += Math.min(Math.floor(Math.log10(repo.stargazers_count + 1)), 5);
    }
    score += githubRepositoryQualityBoost(repo);

    results.push({
      title,
      url: repo.html_url,
      snippet,
      score,
      domain: registrableDomain(repo.html_url),
      engine: 'github',
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

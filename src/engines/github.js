/**
 * engines/github.js — GitHub via public REST API (no browser needed)
 * Rate limit: 10 req/min unauthenticated — enforced via sliding window.
 */

import { scoreResult, applyForkPenalty, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const GITHUB_SEARCH = 'https://api.github.com/search/repositories';
const USER_AGENT = 'god-search/1.0';
const RATE_LIMIT = 10; // requests per window
const WINDOW_MS = 60_000; // 1 minute

// Sliding window rate limiter
const _timestamps = [];

function checkRateLimit() {
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

export async function searchGithub(query, limit = 10) {
  checkRateLimit();

  const url = new URL(GITHUB_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', String(Math.min(limit + 5, 30)));
  url.searchParams.set('sort', 'best_match');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github.v3+json',
      },
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
    // Penalize forks — they're usually noise
    if (repo.fork) score = applyForkPenalty(score);
    // Boost by star count (log scale, capped at +5)
    if (repo.stargazers_count > 0) {
      score += Math.min(Math.floor(Math.log10(repo.stargazers_count + 1)), 5);
    }

    results.push({
      title,
      url: repo.html_url,
      snippet,
      score,
      domain: registrableDomain(repo.html_url),
      engine: 'github',
    });
  }

  return results;
}

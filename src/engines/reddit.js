/**
 * engines/reddit.js — Reddit via public JSON API (no browser needed)
 */

import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const REDDIT_SEARCH = 'https://www.reddit.com/search.json';
const USER_AGENT = 'god-search/1.0 (research tool; github.com/crackion-com/god-search)';

export async function searchReddit(query, limit = 10) {
  const url = new URL(REDDIT_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(limit + 5, 25)));
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('type', 'link');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Reddit API: HTTP ${resp.status}`);
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(data?.data?.children)) {
    throw new Error('Reddit API: unexpected response shape');
  }

  const results = [];
  const seen = new Set();

  for (const child of data.data.children) {
    if (results.length >= limit) break;
    const post = child.data;
    if (!post) continue;

    // Build canonical URL
    const postUrl = post.url?.startsWith('http')
      ? post.url
      : `https://www.reddit.com${post.permalink}`;

    if (seen.has(postUrl)) continue;
    seen.add(postUrl);

    // For self-posts, prefer the reddit thread URL (has discussion)
    const resultUrl = post.is_self
      ? `https://www.reddit.com${post.permalink}`
      : postUrl;

    const title = post.title || '';
    // Combine selftext + subreddit for snippet context
    const selftext = (post.selftext || '').slice(0, 200);
    const snippet = selftext || `r/${post.subreddit} · ${post.score} points`;

    results.push({
      title,
      url: resultUrl,
      snippet: snippet.slice(0, 300),
      score: scoreResult(query, resultUrl, title, snippet),
      domain: registrableDomain(resultUrl),
      engine: 'reddit',
    });
  }

  return results;
}

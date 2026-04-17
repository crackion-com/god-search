/**
 * merger.js — Fast-path + cross-engine URL boost + domain diversity
 *
 * Fast-path: resolves when 4/7 engines complete OR 2000ms elapses.
 * Background: remaining engines finish and update cache silently.
 */

import { scoreResult, crossEngineBoost, registrableDomain } from './scoring.js';
import { updateCache } from './cache.js';

import { searchDdg } from './engines/ddg.js';
import { searchBing } from './engines/bing.js';
import { searchBrave } from './engines/brave.js';
import { searchGoogle } from './engines/google.js';
import { searchReddit } from './engines/reddit.js';
import { searchGithub } from './engines/github.js';
import { searchWikipedia } from './engines/wikipedia.js';

const FAST_PATH_MS = 2000;
const FAST_PATH_MIN_ENGINES = 4;
const DOMAIN_MAX = 2; // max results per domain in final output

const ALL_ENGINES = [
  { name: 'ddg', fn: searchDdg },
  { name: 'brave', fn: searchBrave },
  { name: 'bing', fn: searchBing },
  { name: 'reddit', fn: searchReddit },
  { name: 'wikipedia', fn: searchWikipedia },
  { name: 'github', fn: searchGithub },
  { name: 'google', fn: searchGoogle }, // last — most CAPTCHA-prone
];

/** Normalize a URL for cross-engine deduplication (not for display) */
function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    // Strip tracking params
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) {
      u.searchParams.delete(p);
    }
    // Lowercase scheme + host, strip www, strip trailing slash
    return `${u.protocol}//${u.hostname.replace(/^www\./i, '')}${u.pathname}${u.search}`
      .replace(/\/$/, '')
      .toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function decodeEntities(str) {
  return str
    .replace(/&#x200B;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function mergeEngineResults(engineMap, query, limit) {
  // Collect all results, grouped by normalized URL
  const groups = new Map(); // normalizedUrl → { title, url, snippet, engines[] }

  for (const [engine, results] of engineMap) {
    for (const r of results) {
      const key = normalizeUrlForDedup(r.url);
      if (groups.has(key)) {
        const g = groups.get(key);
        g.engines.push(engine);
        // Keep longest snippet
        if (r.snippet.length > g.snippet.length) g.snippet = r.snippet;
        // Keep shortest (cleanest) URL
        if (r.url.length < g.url.length) g.url = r.url;
      } else {
        groups.set(key, {
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          engines: [engine],
        });
      }
    }
  }

  // Score each merged result
  const scored = [...groups.values()].map(g => {
    const baseScore = scoreResult(query, g.url, g.title, g.snippet);
    const boost = crossEngineBoost(g.engines.length);
    return { ...g, score: baseScore + boost, domain: registrableDomain(g.url) };
  });

  scored.sort((a, b) => b.score - a.score);

  // Domain diversity filter: max DOMAIN_MAX per domain
  const domainCounts = new Map();
  const final = [];

  for (const r of scored) {
    if (final.length >= limit) break;
    const domain = r.domain || 'unknown';
    const count = domainCounts.get(domain) ?? 0;
    if (count >= DOMAIN_MAX) continue;
    domainCounts.set(domain, count + 1);
    final.push({
      title: decodeEntities(r.title).slice(0, 120),
      url: r.url,
      snippet: decodeEntities(r.snippet).slice(0, 300),
      score: r.score,
      engines: r.engines,
      rank: final.length + 1,
    });
  }

  return final;
}

/**
 * Run all engines with fast-path resolution.
 * @param {string} query
 * @param {object} opts - { limit, engines, _cacheOpts }
 * @returns {Promise<{ results, engineStats, elapsed_ms }>}
 */
export async function runSearch(query, opts = {}) {
  const limit = opts.limit ?? 10;
  const allowedEngines = opts.engines ? new Set(opts.engines) : null;
  const engines = allowedEngines
    ? ALL_ENGINES.filter(e => allowedEngines.has(e.name))
    : ALL_ENGINES;

  const startTime = Date.now();
  const engineMap = new Map(); // engine name → results[]
  const engineErrors = new Map(); // engine name → error message
  let completedCount = 0;
  let resolveWait;

  const waitReady = new Promise(r => { resolveWait = r; });

  // Launch all engines concurrently
  const promises = engines.map(async ({ name, fn }) => {
    try {
      const results = await fn(query, limit + 5); // fetch extra for diversity
      engineMap.set(name, results);
      console.error(`[merger] ${name}: ${results.length} results`);
    } catch (err) {
      engineErrors.set(name, err.message);
      console.error(`[merger] ${name} failed: ${err.message}`);
    } finally {
      completedCount++;
      if (completedCount >= FAST_PATH_MIN_ENGINES) resolveWait();
    }
  });

  // Wait for fast-path condition
  await Promise.race([
    waitReady,
    new Promise(r => setTimeout(r, FAST_PATH_MS)),
  ]);

  const fastPathResults = mergeEngineResults(engineMap, query, limit);
  const fastPathElapsed = Date.now() - startTime;
  console.error(`[merger] fast-path: ${completedCount}/${engines.length} engines, ${fastPathResults.length} results, ${fastPathElapsed}ms`);

  // Let remaining engines finish in background and update cache
  if (completedCount < engines.length && opts._cacheOpts) {
    Promise.allSettled(promises).then(() => {
      if (engineMap.size > completedCount) {
        const betterResults = mergeEngineResults(engineMap, query, limit);
        updateCache(query, opts._cacheOpts, {
          results: betterResults,
          engineStats: Object.fromEntries([...engineMap.entries()].map(([k, v]) => [k, v.length])),
          elapsed_ms: Date.now() - startTime,
        });
        console.error(`[merger] background update: ${betterResults.length} results`);
      }
    });
  }

  return {
    results: fastPathResults,
    engineStats: {
      completed: [...engineMap.keys()],
      failed: [...engineErrors.keys()],
      errors: Object.fromEntries(engineErrors),
    },
    elapsed_ms: fastPathElapsed,
  };
}

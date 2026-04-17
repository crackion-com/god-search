/**
 * scoring.js — Result scoring extended from OpenCode ddgsearch plugin.
 * No side effects. Pure functions only.
 */

const OFFICIAL_HOST_PATTERNS = [
  /^docs\./i,
  /^developer\./i,
  /^developers\./i,
  /^api\./i,
];

const OFFICIAL_PATH_PATTERNS = [
  /^\/docs(\/|$)/i,
  /^\/documentation(\/|$)/i,
  /^\/api(\/|$)/i,
  /^\/library(\/|$)/i,
  /^\/reference(\/|$)/i,
  /^\/providers?(\/|$)/i,
  /^\/integrations?(\/|$)/i,
  /^\/manual(\/|$)/i,
  /^\/guide(\/|$)/i,
  /^\/tutorials?(\/|$)/i,
];

const DOCS_PLATFORM_HOST_PATTERNS = [
  /\.readthedocs\.io$/i,
  /\.sst\.dev$/i,
  /^docs\.rs$/i,
  /^pkg\.go\.dev$/i,
];

const OFFICIAL_REGISTRABLE_DOMAINS = new Set([
  'github.com',
  'gitlab.com',
  'ollama.com',
  'openai.com',
  'anthropic.com',
  'langchain.com',
  'crewai.com',
  'sst.dev',
  'python.org',
  'nodejs.org',
  'rust-lang.org',
  'go.dev',
  'mozilla.org',
  'developer.mozilla.org',
  'npmjs.com',
  'pypi.org',
  'crates.io',
]);

const LOW_SIGNAL_HOST_PATTERNS = [
  /^dev\.to$/i,
  /^medium\.com$/i,
  /^towardsdatascience\.com$/i,
  /^hackernoon\.com$/i,
  /^hashnode\./i,
  /^blog\./i,
  /^substack\.com$/i,
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'best', 'can', 'compare', 'comparison', 'current',
  'documentation', 'docs', 'find', 'for', 'from', 'give', 'how', 'in', 'into',
  'is', 'just', 'latest', 'like', 'me', 'of', 'official', 'only', 'or',
  'provider', 'providers', 'return', 'short', 'should', 'site', 'source',
  'sources', 'than', 'the', 'then', 'that', 'this', 'url', 'use', 'web',
  'what', 'with', 'your', 'about', 'also', 'to', 'get', 'using', 'via',
]);

export function registrableDomain(urlString) {
  try {
    const hostname = new URL(urlString).hostname.replace(/^www\./i, '').toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length < 2) return hostname;
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

function keywordTokens(query) {
  return query
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

function overlapScore(text, tokens, multiplier) {
  let score = 0;
  const lower = text.toLowerCase();
  for (const token of tokens) {
    if (lower.includes(token)) score += multiplier;
  }
  return score;
}

/**
 * Score a single search result. Higher = more relevant / trustworthy.
 * @returns {number}
 */
export function scoreResult(query, urlString, title, snippet) {
  let score = 0;
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const path = url.pathname || '/';
    const haystack = `${title} ${snippet}`.toLowerCase();
    const queryTokens = keywordTokens(query);
    const domain = registrableDomain(urlString);

    // Official host prefix (+5)
    if (OFFICIAL_HOST_PATTERNS.some(p => p.test(hostname))) score += 5;
    // Official path (+4)
    if (OFFICIAL_PATH_PATTERNS.some(p => p.test(path))) score += 4;
    // Docs platform (+4)
    if (DOCS_PLATFORM_HOST_PATTERNS.some(p => p.test(hostname))) score += 4;
    // Known official domain (+5)
    if (OFFICIAL_REGISTRABLE_DOMAINS.has(domain) || OFFICIAL_REGISTRABLE_DOMAINS.has(hostname)) score += 5;

    // github.com gets extra boost (+4 more on top of domain boost)
    if (hostname === 'github.com') score += 4;
    // .org gets slight boost
    if (hostname.endsWith('.org')) score += 1;

    // Path penalties
    if (path === '/' && !OFFICIAL_HOST_PATTERNS.some(p => p.test(hostname))) score -= 2;
    if (path.includes('/search')) score -= 6;
    if (path.includes('/issues') || path.includes('/pull/')) score -= 4;
    if (path.includes('/discussions')) score -= 2;
    if (path.includes('/releases')) score += 2;
    if (path.includes('/blog')) score -= 2;

    // Low signal hosts (-5)
    if (LOW_SIGNAL_HOST_PATTERNS.some(p => p.test(hostname))) score -= 5;

    // Keyword overlap
    score += overlapScore(hostname, queryTokens, 3);
    score += overlapScore(path, queryTokens, 2);
    score += overlapScore(haystack, queryTokens, 1);

    // Content signals
    if (haystack.includes('official')) score += 2;
    if (haystack.includes('documentation') || haystack.includes('docs')) score += 3;
    if (haystack.includes('api reference')) score += 2;
    if (haystack.includes('tutorial')) score -= 1;
    if (haystack.includes('top ') || haystack.includes('best ')) score -= 1;
    if (haystack.includes(' vs ')) score -= 1;
  } catch {
    // Invalid URL — no score
  }
  return score;
}

/**
 * GitHub-specific: penalize forked repos.
 */
export function applyForkPenalty(score) {
  return score - 3;
}

/**
 * Cross-engine URL boost constants.
 * Same URL appearing across multiple engines signals higher authority.
 */
export function crossEngineBoost(engineCount) {
  if (engineCount >= 4) return 12;
  if (engineCount >= 3) return 8;
  if (engineCount >= 2) return 4;
  return 0;
}

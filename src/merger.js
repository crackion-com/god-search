/**
 * merger.js — Fast-path + cross-engine URL boost + domain diversity
 *
 * Fast-path: resolves when 4/7 engines complete OR 2000ms elapses.
 * Background: remaining engines finish and update cache silently.
 */

import { scoreResult, crossEngineBoost, registrableDomain } from './scoring.js';
import { buildLanguageContext, detectLanguage, keywordTokens, normalizeText, tokenHitCount } from './language.js';
import { updateCache } from './cache.js';
import {
  buildProviderHealth,
  providerCanRun,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-health.js';

import { searchDdg } from './engines/ddg.js';
import { searchBing } from './engines/bing.js';
import { searchBrave } from './engines/brave.js';
import { searchGoogle } from './engines/google.js';
import { searchReddit } from './engines/reddit.js';
import { searchGithub } from './engines/github.js';
import { searchWikipedia } from './engines/wikipedia.js';
import { searchStackOverflow } from './engines/stackoverflow.js';
import { searchHackerNews } from './engines/hackernews.js';
import { searchNpm } from './engines/npm.js';
import { searchOfficial } from './engines/official.js';
import { SEARCH_CONFIG } from './config.js';

const DEFAULT_DOMAIN_MAX = 2; // max results per domain in final output
const INTENT_DOMAIN_MAX = {
  code: {
    'github.com': 5,
    'stackoverflow.com': 4,
    'npmjs.com': 4,
  },
  discussion: {
    'reddit.com': 5,
    'ycombinator.com': 4,
    'news.ycombinator.com': 4,
  },
};
const RRF_K = 60;
const FRESHNESS_HALF_LIFE_DAYS = 365;
const FAST_SOFT_MS = Math.min(SEARCH_CONFIG.fastPathMs, 1700);
const FAST_HARD_MS = Math.min(SEARCH_CONFIG.fastPathMaxMs, 1900);
const DOC_PATH_RE = /^\/(docs|documentation|api|reference|guide|guides|manual|tutorial|tutorials|library|integrations?|providers?)(\/|$)/i;
const DOC_HOST_RE = /^(docs|developer|developers|api)\./i;
const DOC_REGISTRY_HOSTS = new Set([
  'docs.rs',
  'pkg.go.dev',
  'pypi.org',
  'npmjs.com',
  'crates.io',
  'arxiv.org',
]);
const KNOWN_OFFICIAL_DOMAINS = new Set([
  'anthropic.com',
  'openai.com',
  'ollama.com',
  'langchain.com',
  'nodejs.org',
  'rust-lang.org',
  'python.org',
  'postgresql.org',
  'docker.com',
  'react.dev',
  'git-scm.com',
  'mozilla.org',
  'go.dev',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'arxiv.org',
  'rfc-editor.org',
  'ietf.org',
  'w3.org',
  'unicode.org',
  'nasa.gov',
  'cern.ch',
]);
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com']);
const DISCUSSION_HOSTS = new Set(['reddit.com', 'redditmedia.com', 'ycombinator.com']);
const FACTUAL_HOSTS = new Set(['wikipedia.org']);
const WEB_SERP_ENGINES = new Set(['ddg', 'bing', 'google', 'brave']);
const ENGINE_EVIDENCE_FAMILY = {
  ddg: 'web_serp',
  bing: 'web_serp',
  google: 'web_serp',
  brave: 'web_serp',
};
const PRIMARY_FACTUAL_DOMAINS = new Set(['nasa.gov', 'cern.ch', 'w3.org']);
const STANDARDS_DOMAINS = new Set(['rfc-editor.org', 'ietf.org', 'w3.org', 'unicode.org']);
const RESERVED_NOISE_DOMAINS = new Set(['example.com', 'example.net', 'invalid']);
const FRESHNESS_QUERY_RE = /\b(202[0-9]|latest|new|newest|recent|current|currently|today|this year|updated|release|releases|changelog|version|versions)\b/i;
const STANDARDS_QUERY_RE = /\b(standard|standards|specification|specifications|algorithm|format|rfc)\b/i;
const SOURCE_RELIABILITY = {
  docs: {
    ddg: 1.2,
    google: 1.2,
    bing: 1,
    brave: 1,
    github: -0.4,
    stackoverflow: -0.6,
    npm: 0.4,
    official: 2,
    hackernews: -0.8,
    wikipedia: -0.3,
    reddit: -1,
  },
  code: {
    github: 2,
    stackoverflow: 1.4,
    npm: 1.6,
    official: 1,
    hackernews: 0.2,
    ddg: 0.8,
    google: 0.8,
    bing: 0.7,
    brave: 0.7,
    reddit: 0.2,
    wikipedia: -0.5,
  },
  discussion: {
    reddit: 2,
    hackernews: 1.6,
    ddg: 0.6,
    google: 0.6,
    bing: 0.5,
    brave: 0.5,
    stackoverflow: 0,
    npm: -0.6,
    official: 0,
    github: -0.4,
    wikipedia: -0.5,
  },
  factual: {
    wikipedia: 2,
    ddg: 0.8,
    google: 0.8,
    bing: 0.7,
    brave: 0.7,
    github: -0.6,
    stackoverflow: -0.4,
    npm: -0.4,
    official: 1.2,
    hackernews: -0.4,
    reddit: -1,
  },
  general: {
    ddg: 1,
    google: 1,
    bing: 0.9,
    brave: 0.9,
    wikipedia: 0.8,
    stackoverflow: 0,
    npm: 0.4,
    official: 1.2,
    hackernews: 0.4,
    github: 0.2,
    reddit: -0.2,
  },
};
const ALL_ENGINES = {
  official: { name: 'official', fn: searchOfficial, kind: 'api' },
  ddg: { name: 'ddg', fn: searchDdg, kind: 'browser' },
  brave: { name: 'brave', fn: searchBrave, kind: 'browser' },
  bing: { name: 'bing', fn: searchBing, kind: 'browser' },
  reddit: { name: 'reddit', fn: searchReddit, kind: 'api' },
  wikipedia: { name: 'wikipedia', fn: searchWikipedia, kind: 'api' },
  github: { name: 'github', fn: searchGithub, kind: 'api' },
  stackoverflow: { name: 'stackoverflow', fn: searchStackOverflow, kind: 'api' },
  hackernews: { name: 'hackernews', fn: searchHackerNews, kind: 'api' },
  npm: { name: 'npm', fn: searchNpm, kind: 'api' },
  google: { name: 'google', fn: searchGoogle, kind: 'browser' },
};

const ENGINE_ORDERS = {
  docs: ['official', 'ddg', 'google', 'bing', 'brave', 'npm', 'github', 'wikipedia', 'stackoverflow', 'reddit', 'hackernews'],
  code: ['github', 'stackoverflow', 'npm', 'official', 'ddg', 'google', 'brave', 'bing', 'hackernews', 'reddit', 'wikipedia'],
  discussion: ['reddit', 'hackernews', 'ddg', 'google', 'bing', 'brave', 'stackoverflow', 'github', 'wikipedia', 'npm', 'official'],
  factual: ['official', 'wikipedia', 'ddg', 'google', 'bing', 'brave', 'github', 'stackoverflow', 'hackernews', 'reddit', 'npm'],
  general: ['official', 'ddg', 'google', 'bing', 'brave', 'hackernews', 'stackoverflow', 'npm', 'reddit', 'wikipedia', 'github'],
};

const INTENT_PROFILES = {
  docs: {
    minSettled: 2,
    minUseful: 2,
    usefulEngines: new Set(['official', 'ddg', 'google', 'bing']),
    softMs: FAST_SOFT_MS,
    hardMs: FAST_HARD_MS,
    requireHighConfidence: true,
  },
  code: {
    minSettled: 2,
    minUseful: 2,
    usefulEngines: new Set(['github', 'stackoverflow', 'npm', 'official', 'ddg', 'google', 'bing', 'brave']),
    softMs: FAST_SOFT_MS,
    hardMs: FAST_HARD_MS,
    requireHighConfidence: true,
  },
  discussion: {
    minSettled: 2,
    minUseful: 1,
    usefulEngines: new Set(['reddit', 'hackernews', 'ddg', 'google', 'bing']),
    softMs: FAST_SOFT_MS,
    hardMs: FAST_HARD_MS,
    requireHighConfidence: false,
  },
  factual: {
    minSettled: 2,
    minUseful: 1,
    usefulEngines: new Set(['official', 'wikipedia', 'ddg', 'google', 'bing']),
    softMs: FAST_SOFT_MS,
    hardMs: FAST_HARD_MS,
    requireHighConfidence: false,
  },
  general: {
    minSettled: Math.min(SEARCH_CONFIG.fastPathMinEngines, 2),
    minUseful: 2,
    usefulEngines: new Set(Object.keys(ALL_ENGINES)),
    softMs: FAST_SOFT_MS,
    hardMs: FAST_HARD_MS,
    requireHighConfidence: false,
  },
};

function allEnginesList(searchConfig = SEARCH_CONFIG) {
  return Object.values(ALL_ENGINES).filter(engine => {
    if (engine.name === 'brave' && !searchConfig.enableBraveByDefault) return false;
    return true;
  });
}

function detectQueryIntent(query) {
  const lower = query.toLowerCase();
  if (/\b(reddit|hacker\s*news|hn|show hn|ask hn|discussion|forum|thread|threads|opinion|opinions|community|communities|compare|vs\.?|versus)\b/.test(lower)) {
    return 'discussion';
  }
  if (/\b(github|gitlab|repo|repository|repositories|source code|implementation|implementations|example code|examples|stack\s*overflow|stackoverflow|stackexchange|stack\s*exchange|error|exception|traceback|debug|bug|fix|npm|package|packages|node package|typescript library|javascript library)\b/.test(lower)) {
    return 'code';
  }
  if (/\b(docs?|documentation|documentations|api|sdk|reference|references|guide|guides|handbook|manual|tutorial|tutorials|library|libraries|integration|integrations)\b/.test(lower)) {
    return 'docs';
  }
  if (/^(what is|who is|define|definition of|history of|list of)\b/.test(lower) || /\b(wikipedia|meaning|definition|history)\b/.test(lower)) {
    return 'factual';
  }
  return 'general';
}

function orderEnginesForIntent(engines, intent) {
  const order = ENGINE_ORDERS[intent] || ENGINE_ORDERS.general;
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...engines].sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99));
}

/**
 * Pure search planning helper for tests and callers that need routing insight.
 * Explicit engine filters may include Brave even when Brave is disabled by default.
 */
export function planSearchEngines(query, opts = {}) {
  const searchConfig = opts.searchConfig ?? SEARCH_CONFIG;
  const intent = opts.intent ?? detectQueryIntent(query);
  const allowedEngines = opts.engines ? new Set(opts.engines) : null;
  const enginePool = allowedEngines ? Object.values(ALL_ENGINES) : allEnginesList(searchConfig);
  const engines = orderEnginesForIntent(
    allowedEngines
      ? enginePool.filter(e => allowedEngines.has(e.name))
      : enginePool,
    intent,
  ).map(({ name, kind }) => ({ name, kind }));

  return {
    intent,
    engines,
    attempted: engines.map(engine => engine.name),
  };
}

function enginesForRunSearch(attempted, engineFns = null, { force = false } = {}) {
  return attempted
    .map(name => {
      const engine = ALL_ENGINES[name];
      if (!engine) return null;
      if (!force && !providerCanRun(name)) return null;
      return {
        ...engine,
        fn: engineFns?.[name] || engine.fn,
      };
    })
    .filter(Boolean);
}

function resultSignal(result) {
  try {
    const url = new URL(result.url);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const domain = registrableDomain(result.url);
    return {
      hostname,
      domain,
      path: url.pathname || '/',
      score: result.score ?? 0,
    };
  } catch {
    return {
      hostname: '',
      domain: '',
      path: '/',
      score: result.score ?? 0,
    };
  }
}

function isOfficialish(signal) {
  return (
    (DOC_HOST_RE.test(signal.hostname) && isKnownOfficialDomain(signal)) ||
    DOC_PATH_RE.test(signal.path) ||
    DOC_REGISTRY_HOSTS.has(signal.hostname) ||
    DOC_REGISTRY_HOSTS.has(signal.domain) ||
    KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) ||
    KNOWN_OFFICIAL_DOMAINS.has(signal.domain)
  );
}

function isDirectDocsShape(signal) {
  return (
    DOC_HOST_RE.test(signal.hostname) ||
    DOC_PATH_RE.test(signal.path) ||
    DOC_REGISTRY_HOSTS.has(signal.hostname) ||
    DOC_REGISTRY_HOSTS.has(signal.domain)
  );
}

function isOfficialDocsPath(signal) {
  return (
    isKnownOfficialDomain(signal) &&
    (
      DOC_HOST_RE.test(signal.hostname) ||
      /^\/(?:[a-z]{2}\/)?(?:api|docs|documentation|reference|library|manual)(\/|$)/i.test(signal.path) ||
      /^\/cargo(?:\/(?:reference|commands)(\/|$)|$)/i.test(signal.path)
    )
  );
}

function isKnownOfficialDomain(signal) {
  return KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) || KNOWN_OFFICIAL_DOMAINS.has(signal.domain);
}

function isPrimaryAuthority(signal) {
  return (
    PRIMARY_FACTUAL_DOMAINS.has(signal.hostname) ||
    PRIMARY_FACTUAL_DOMAINS.has(signal.domain) ||
    (signal.hostname.endsWith('.gov') && !signal.hostname.includes('github'))
  );
}

function isStandardsAuthority(signal, result) {
  const standardsDomain = STANDARDS_DOMAINS.has(signal.hostname) || STANDARDS_DOMAINS.has(signal.domain);
  return standardsDomain;
}

function isHighConfidenceResult(result, intent) {
  const signal = resultSignal(result);
  const officialish = isOfficialish(signal);

  if (intent === 'docs') {
    if (DISCUSSION_HOSTS.has(signal.domain) || FACTUAL_HOSTS.has(signal.domain)) return false;
    if (CODE_HOSTS.has(signal.domain)) return false;
    return officialish;
  }
  if (intent === 'code') {
    return CODE_HOSTS.has(signal.domain) || officialish || signal.score >= 18;
  }
  if (intent === 'discussion') {
    return DISCUSSION_HOSTS.has(signal.domain) || signal.score >= 14;
  }
  if (intent === 'factual') {
    return FACTUAL_HOSTS.has(signal.domain) || officialish || signal.score >= 14;
  }
  return signal.score >= 18 || (result.engines?.length ?? 0) > 1;
}

function authorityAdjustment(result, intent, query, authorityContext = {}) {
  const signal = resultSignal(result);
  const standardsAuthority = isStandardsAuthority(signal, result);
  const primaryAuthority = isPrimaryAuthority(signal);
  const wikipediaFallback = signal.domain === 'wikipedia.org' && authorityContext.hasPrimaryAuthority;

  let delta = 0;
  if ((intent === 'general' || intent === 'docs') && STANDARDS_QUERY_RE.test(query) && standardsAuthority) {
    delta += 18;
  }
  if (intent === 'factual' && primaryAuthority) {
    delta += 8;
  }
  if (intent === 'factual' && standardsAuthority && STANDARDS_QUERY_RE.test(query)) {
    delta += 6;
  }
  if (wikipediaFallback) {
    delta -= 4;
  }
  return delta;
}

function intentScoreAdjustment(result, intent) {
  const signal = resultSignal(result);
  const officialish = isOfficialish(signal);
  const knownOfficial = isKnownOfficialDomain(signal);
  const reservedNoise = RESERVED_NOISE_DOMAINS.has(signal.domain);

  if (intent === 'docs') {
    let delta = 0;
    if (reservedNoise) delta -= 8;
    if (officialish) delta += 8;
    if (knownOfficial) delta += 6;
    if (isOfficialDocsPath(signal)) delta += 5;
    if (CODE_HOSTS.has(signal.domain)) delta -= 13;
    if (DISCUSSION_HOSTS.has(signal.domain)) delta -= 10;
    if (FACTUAL_HOSTS.has(signal.domain)) delta -= 4;
    return delta;
  }

  if (intent === 'code') {
    let delta = 0;
    if (reservedNoise) delta -= 8;
    if (CODE_HOSTS.has(signal.domain)) delta += 10;
    if (officialish) delta += 3;
    if (knownOfficial) delta += 2;
    if (DISCUSSION_HOSTS.has(signal.domain)) delta -= 6;
    return delta;
  }

  if (intent === 'discussion') {
    let delta = 0;
    if (reservedNoise) delta -= 8;
    if (DISCUSSION_HOSTS.has(signal.domain)) delta += 10;
    if (CODE_HOSTS.has(signal.domain)) delta -= 4;
    if (FACTUAL_HOSTS.has(signal.domain)) delta -= 2;
    return delta;
  }

  if (intent === 'factual') {
    let delta = 0;
    if (reservedNoise) delta -= 8;
    if (FACTUAL_HOSTS.has(signal.domain)) delta += 10;
    if (officialish) delta += 3;
    if (knownOfficial) delta += 2;
    if (DISCUSSION_HOSTS.has(signal.domain)) delta -= 4;
    if (CODE_HOSTS.has(signal.domain)) delta -= 4;
    return delta;
  }

  if (intent === 'general') {
    let delta = 0;
    if (reservedNoise) delta -= 8;
    if (officialish) delta += 3;
    if (knownOfficial) delta += 2;
    if (CODE_HOSTS.has(signal.domain)) delta -= 13;
    return delta;
  }

  return 0;
}

function rankingTokens(text, languageContext) {
  return keywordTokens(text, languageContext);
}

function textMatchAdjustment(query, result, languageContext) {
  const tokens = [...new Set(rankingTokens(query, languageContext))];
  if (tokens.length === 0) return 0;

  const title = result.title || '';
  const snippet = result.snippet || '';
  const combined = `${title} ${snippet}`;
  const titleLower = normalizeText(title, languageContext);
  const combinedLower = normalizeText(combined, languageContext);
  const titleHits = tokenHitCount(tokens, title, languageContext);
  const snippetHits = tokenHitCount(tokens, snippet, languageContext);
  const combinedHits = tokenHitCount(tokens, combined, languageContext);
  const titleCoverage = titleHits / tokens.length;
  const coverage = combinedHits / tokens.length;
  const phrase = tokens.join(' ');

  let delta = Math.min(6, titleHits * 1.5 + snippetHits * 0.75);
  if (tokens.length >= 2 && titleLower.includes(phrase)) delta += 3;
  if (tokens.length >= 2 && combinedLower.includes(phrase)) delta += 1;
  if (titleCoverage >= 0.75) delta += 2;
  if (coverage >= 0.75) delta += 2;
  if (tokens.length >= 2 && titleHits === tokens.length) delta += 3;
  if (tokens.length >= 3 && coverage === 1) delta += 2;
  if (tokens.length >= 3 && coverage < 0.34) delta -= 2;
  if (tokens.length >= 4 && coverage < 0.5) delta -= 1;
  if (tokens.length >= 3 && combinedHits === 0) delta -= 3;
  return delta;
}

function languageMatchAdjustment(result, languageContext) {
  const language = languageContext?.language;
  if (!language || language === 'en') return 0;

  const detected = detectLanguage(`${result.title || ''} ${result.snippet || ''}`);
  if (detected.language === language && detected.confidence >= 0.5) return 3;
  if (detected.language === language || detected.confidence < 0.35) return 1;
  return 0;
}

function engineEvidenceFamily(engine) {
  return ENGINE_EVIDENCE_FAMILY[engine] || engine;
}

function evidenceFamilyRanks(sourceRanks) {
  const familyRanks = {};
  for (const [engine, rank] of Object.entries(sourceRanks)) {
    const family = engineEvidenceFamily(engine);
    if (familyRanks[family] == null || rank < familyRanks[family]) {
      familyRanks[family] = rank;
    }
  }
  return familyRanks;
}

function sourceReliabilityAdjustment(sourceRanks, intent) {
  const profile = SOURCE_RELIABILITY[intent] || SOURCE_RELIABILITY.general;
  const familyWeights = {};
  for (const [engine, rank] of Object.entries(sourceRanks)) {
    const family = engineEvidenceFamily(engine);
    const weight = profile[engine] ?? 0;
    const existing = familyWeights[family];
    if (
      existing == null ||
      Math.abs(weight) > Math.abs(existing.weight) ||
      (Math.abs(weight) === Math.abs(existing.weight) && rank < existing.rank)
    ) {
      familyWeights[family] = { weight, rank };
    }
  }

  return Object.values(familyWeights).reduce((sum, { weight, rank }) => {
    if (weight === 0) return sum;
    const rankWeight = rank <= 3 ? 1 : rank <= 10 ? 0.7 : 0.4;
    return sum + (weight * rankWeight);
  }, 0);
}

function visibleDateMs(result) {
  const text = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  const isoMatch = text.match(/\b(20[0-3][0-9])[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12][0-9]|3[01])\b/);
  if (isoMatch) {
    const ms = Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (Number.isFinite(ms)) return ms;
  }

  const monthMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+([0-3]?\d),?\s+(20[0-3]\d)\b/i);
  if (monthMatch) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[monthMatch[1].slice(0, 3).toLowerCase()];
    const ms = Date.UTC(Number(monthMatch[3]), month, Number(monthMatch[2]));
    if (Number.isFinite(ms)) return ms;
  }

  const yearMatches = [...text.matchAll(/\b(20[0-3][0-9])\b/g)].map(match => Number(match[1]));
  if (yearMatches.length === 0) return null;
  return Date.UTC(Math.max(...yearMatches), 0, 1);
}

function freshnessAdjustment(query, result, newestVisibleDateMs) {
  if (!FRESHNESS_QUERY_RE.test(query) || newestVisibleDateMs == null) return 0;
  const resultDateMs = visibleDateMs(result);
  if (resultDateMs == null) return 0;

  const ageDays = Math.max(0, (newestVisibleDateMs - resultDateMs) / 86400000);
  const recency = Math.max(0, 1 - (ageDays / FRESHNESS_HALF_LIFE_DAYS));
  let delta = recency * 5;

  const requestedYear = query.match(/\b(202[0-9])\b/)?.[1];
  if (requestedYear && new Date(resultDateMs).getUTCFullYear() === Number(requestedYear)) {
    delta += 3;
  }
  if (ageDays > FRESHNESS_HALF_LIFE_DAYS * 3) delta -= 2;
  return delta;
}

function officialDomainAdjustment(result, intent, officialDomains) {
  const signal = resultSignal(result);
  if (!officialDomains.has(signal.domain)) return 0;
  if (CODE_HOSTS.has(signal.domain) || DISCUSSION_HOSTS.has(signal.domain)) return 0;
  if (isDirectDocsShape(signal)) return 0;

  if (intent === 'docs') return 3;
  if (intent === 'factual' || intent === 'general') return 3;
  return 0;
}

function usefulCompletedCount(engineMap, intent) {
  const profile = INTENT_PROFILES[intent] || INTENT_PROFILES.general;
  let count = 0;
  for (const [engine, results] of engineMap.entries()) {
    if (!profile.usefulEngines.has(engine)) continue;
    if (Array.isArray(results) && results.length > 0) count++;
  }
  return count;
}

function hasHighConfidence(engineMap, intent) {
  for (const results of engineMap.values()) {
    for (const result of results.slice(0, 3)) {
      if (isHighConfidenceResult(result, intent)) return true;
    }
  }
  return false;
}

function buildEngineStats(engineMap, engineErrors, attempted, skipped = []) {
  const counts = {};
  const completed = [];
  const failed = [];
  const errors = {};

  for (const name of attempted) {
    if (engineMap.has(name)) {
      completed.push(name);
      counts[name] = engineMap.get(name).length;
      continue;
    }
    if (engineErrors.has(name)) {
      failed.push(name);
      counts[name] = 0;
      errors[name] = engineErrors.get(name);
    }
  }

  const skippedNames = skipped.map(item => item.engine);
  const pending = attempted.filter(name =>
    !completed.includes(name) &&
    !failed.includes(name) &&
    !skippedNames.includes(name)
  );
  return {
    attempted,
    completed,
    failed,
    pending,
    skipped,
    counts,
    errors,
    health: buildProviderHealth(attempted),
  };
}

function shouldResolveFastPath({ intent, engineMap, engineErrors, attempted, elapsedMs }) {
  const profile = INTENT_PROFILES[intent] || INTENT_PROFILES.general;
  const settled = engineMap.size + engineErrors.size;
  const useful = usefulCompletedCount(engineMap, intent);
  const confident = hasHighConfidence(engineMap, intent);

  if (settled >= attempted.length) return true;
  if (elapsedMs >= profile.hardMs) return true;
  if (settled < profile.minSettled) return false;
  if (useful < profile.minUseful) return false;
  if (profile.requireHighConfidence && !confident) return false;
  return elapsedMs >= profile.softMs || confident;
}

/** Normalize a URL for cross-engine deduplication (not for display) */
function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Strip tracking params
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(p) || /^(ref|fbclid|gclid|igshid|mc_cid|mc_eid|trk|spm|source)$/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    u.searchParams.sort();

    let path = u.pathname || '/';
    path = path.replace(/\/index\.(html?|php)$/i, '/');
    path = path.replace(/\/amp\/?$/i, '/');

    // Lowercase scheme + host, strip www/default ports, strip trailing slash.
    const protocol = u.protocol === 'http:' ? 'https:' : u.protocol.toLowerCase();
    const port = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')
      ? ''
      : u.port ? `:${u.port}` : '';
    return `${protocol}//${u.hostname.replace(/^www\./i, '').toLowerCase()}${port}${path}${u.search}`
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

function normalizeSourceRank(result, fallbackRank) {
  const rank = Number(result?.sourceRank ?? result?.rank ?? fallbackRank);
  if (!Number.isFinite(rank) || rank < 1) return fallbackRank;
  return Math.floor(rank);
}

function upsertSourceRank(group, engine, rank) {
  const existing = group.sourceRanks[engine];
  if (existing == null || rank < existing) {
    group.sourceRanks[engine] = rank;
  }
  if (!group.engines.includes(engine)) {
    group.engines.push(engine);
  }
}

function upsertSourceScore(group, engine, score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return;
  const existing = group.sourceScores[engine];
  if (existing == null || numeric > existing) {
    group.sourceScores[engine] = numeric;
  }
}

function sourceRankBonus(sourceRanks, baseScore) {
  if (baseScore <= 0) return 0;
  return Object.values(sourceRanks).reduce((sum, rank) => {
    const bonusRank = rank <= 3 ? 1 : rank;
    return sum + (RRF_K / (RRF_K + bonusRank));
  }, 0);
}

function sourceProvidedScoreAdjustment(sourceScores, intent) {
  if (intent !== 'code') return 0;
  const githubScore = sourceScores.github;
  if (!Number.isFinite(githubScore) || githubScore <= 0) return 0;
  return Math.min(18, githubScore * 0.14);
}

function domainMaxForIntent(domain, intent, officialDomains = new Set()) {
  if (intent === 'docs' && officialDomains.has(domain) && !CODE_HOSTS.has(domain)) return 3;
  return INTENT_DOMAIN_MAX[intent]?.[domain] ?? DEFAULT_DOMAIN_MAX;
}

function hasDiscussionVerticalEvidence(result) {
  return (
    result.sourceRanks?.reddit != null ||
    result.sourceRanks?.hackernews != null ||
    DISCUSSION_HOSTS.has(result.domain)
  );
}

function isWebSerpOnlyResult(result) {
  const engines = Object.keys(result.sourceRanks || {});
  return engines.length > 0 && engines.every(engine => WEB_SERP_ENGINES.has(engine));
}

function shouldKeepDiscussionResult(result, hasDiscussionVertical) {
  if (!hasDiscussionVertical) return true;
  if (!isWebSerpOnlyResult(result)) return true;
  return DISCUSSION_HOSTS.has(result.domain);
}

export function mergeEngineResults(engineMap, query, limit, intent = 'general', languageContext = null) {
  const localeContext = languageContext?.hints ? languageContext : buildLanguageContext(query, languageContext || {});
  // Collect all results, grouped by normalized URL
  const groups = new Map(); // normalizedUrl → { title, url, snippet, engines[], sourceRanks{} }

  for (const [engine, results] of engineMap) {
    for (const [index, r] of results.entries()) {
      const key = normalizeUrlForDedup(r.url);
      const sourceRank = normalizeSourceRank(r, index + 1);
      if (groups.has(key)) {
        const g = groups.get(key);
        upsertSourceRank(g, engine, sourceRank);
        upsertSourceScore(g, engine, r.score);
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
          sourceRanks: { [engine]: sourceRank },
          sourceScores: Number.isFinite(Number(r.score)) ? { [engine]: Number(r.score) } : {},
        });
      }
    }
  }

  const officialDomains = new Set();
  const authorityContext = { hasPrimaryAuthority: false };
  for (const g of groups.values()) {
    const signal = resultSignal(g);
    if (signal.domain && (isOfficialish(signal) || isKnownOfficialDomain(signal))) officialDomains.add(signal.domain);
    if (isPrimaryAuthority(signal)) authorityContext.hasPrimaryAuthority = true;
  }

  const visibleDates = [...groups.values()]
    .map(visibleDateMs)
    .filter(ms => ms != null);
  const newestVisibleDateMs = visibleDates.length ? Math.max(...visibleDates) : null;

  // Score each merged result
  const scored = [...groups.values()].map(g => {
    const baseScore = scoreResult(query, g.url, g.title, g.snippet, localeContext);
    const familyRanks = evidenceFamilyRanks(g.sourceRanks);
    const boost = crossEngineBoost(Object.keys(familyRanks).length);
    const nativeRankBoost = sourceRankBonus(familyRanks, baseScore);
    const textMatchBoost = textMatchAdjustment(query, g, localeContext);
    const officialDomainBoost = officialDomainAdjustment(g, intent, officialDomains);
    const sourceReliabilityBoost = sourceReliabilityAdjustment(g.sourceRanks, intent);
    const freshnessBoost = freshnessAdjustment(query, g, newestVisibleDateMs);
    const authorityBoost = authorityAdjustment(g, intent, query, authorityContext);
    const languageBoost = languageMatchAdjustment(g, localeContext);
    const sourceProvidedBoost = sourceProvidedScoreAdjustment(g.sourceScores, intent);
    return {
      ...g,
      score: baseScore + boost + nativeRankBoost + intentScoreAdjustment(g, intent) + textMatchBoost + officialDomainBoost + sourceReliabilityBoost + freshnessBoost + authorityBoost + languageBoost + sourceProvidedBoost,
      rankScore: nativeRankBoost,
      crossEngineScore: boost,
      evidenceFamilyRanks: familyRanks,
      textMatchScore: textMatchBoost,
      officialDomainScore: officialDomainBoost,
      sourceReliabilityScore: sourceReliabilityBoost,
      freshnessScore: freshnessBoost,
      authorityScore: authorityBoost,
      languageScore: languageBoost,
      sourceProvidedScore: sourceProvidedBoost,
      domain: registrableDomain(g.url),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Domain diversity filter: default cap with intent-specific allowances.
  const domainCounts = new Map();
  const final = [];
  const hasDiscussionVertical = intent === 'discussion' && scored.some(hasDiscussionVerticalEvidence);

  for (const r of scored) {
    if (final.length >= limit) break;
    const domain = r.domain || 'unknown';
    if (intent === 'discussion' && !shouldKeepDiscussionResult(r, hasDiscussionVertical)) continue;
    const count = domainCounts.get(domain) ?? 0;
    if (count >= domainMaxForIntent(domain, intent, officialDomains)) continue;
    domainCounts.set(domain, count + 1);
    final.push({
      title: decodeEntities(r.title).slice(0, 120),
      url: r.url,
      snippet: decodeEntities(r.snippet).slice(0, 300),
      score: r.score,
      engines: r.engines,
      sourceRanks: r.sourceRanks,
      evidence: {
        engines: r.engines,
        cross_engine_count: r.engines.length,
        evidence_family_count: Object.keys(r.evidenceFamilyRanks).length,
        evidence_families: Object.keys(r.evidenceFamilyRanks),
        domain,
        source_ranks: r.sourceRanks,
        evidence_family_ranks: r.evidenceFamilyRanks,
        cross_engine_bonus: r.crossEngineScore,
        native_rank_bonus: r.rankScore,
        text_match_bonus: r.textMatchScore,
        official_domain_bonus: r.officialDomainScore,
        source_reliability_bonus: r.sourceReliabilityScore,
        freshness_bonus: r.freshnessScore,
        authority_bonus: r.authorityScore,
        language_bonus: r.languageScore,
        source_provided_bonus: r.sourceProvidedScore,
      },
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
  const languageContext = buildLanguageContext(query, opts);
  const plan = planSearchEngines(query, opts);
  const intent = plan.intent;
  const attempted = plan.attempted;
  const forceEngines = !!opts.engines;
  const engines = enginesForRunSearch(attempted, opts._engineFns, { force: forceEngines });
  const runnableNames = new Set(engines.map(engine => engine.name));
  const skipped = attempted
    .filter(name => !runnableNames.has(name))
    .map(name => {
      const health = buildProviderHealth([name])[name];
      return {
        engine: name,
        state: health.state,
        reason: health.reason,
        retry_after_ms: health.retry_after_ms,
      };
    });

  const startTime = Date.now();
  const engineMap = new Map(); // engine name → results[]
  const engineErrors = new Map(); // engine name → error message

  // Launch all engines concurrently
  const promises = engines.map(async ({ name, fn }) => {
    try {
      const results = await fn(query, limit + 5, languageContext); // fetch extra for diversity
      engineMap.set(name, results);
      recordProviderSuccess(name);
      console.error(`[merger] ${name}: ${results.length} results`);
    } catch (err) {
      engineErrors.set(name, err.message);
      recordProviderFailure(name, err);
      console.error(`[merger] ${name} failed: ${err.message}`);
    }
  });
  const backgroundPromise = Promise.allSettled(promises);

  // Poll for a quality-aware fast-path condition.
  while (true) {
    const elapsedMs = Date.now() - startTime;
    if (shouldResolveFastPath({
      intent,
      engineMap,
      engineErrors,
      attempted,
      elapsedMs,
    })) {
      break;
    }
    await new Promise(r => setTimeout(r, SEARCH_CONFIG.fastPathPollMs));
  }

  const fastPathResults = mergeEngineResults(engineMap, query, limit, intent, languageContext);
  const fastPathElapsed = Date.now() - startTime;
  const fastPathEngineCount = engineMap.size;
  const fastPathStats = buildEngineStats(engineMap, engineErrors, attempted, skipped);
  const settledCount = fastPathStats.completed.length + fastPathStats.failed.length;
  console.error(`[merger] fast-path(${intent}): ${settledCount}/${engines.length} settled, ${fastPathResults.length} results, ${fastPathElapsed}ms`);

  if (opts.awaitBackground) {
    await backgroundPromise;
    const finalStats = buildEngineStats(engineMap, engineErrors, attempted, skipped);
    return {
      results: mergeEngineResults(engineMap, query, limit, intent, languageContext),
      partial: finalStats.pending.length > 0 || finalStats.failed.length > 0 || finalStats.skipped.length > 0,
      engineStats: finalStats,
      elapsed_ms: Date.now() - startTime,
      intent,
      locale: languageContext.locale,
      language: languageContext.language,
    };
  }

  // Let remaining engines finish in background and update cache
  if (settledCount < engines.length && opts._cacheOpts) {
    backgroundPromise.then(() => {
      const finalStats = buildEngineStats(engineMap, engineErrors, attempted, skipped);
      if (
        engineMap.size > fastPathEngineCount ||
        finalStats.failed.length !== fastPathStats.failed.length
      ) {
        const betterResults = mergeEngineResults(engineMap, query, limit, intent, languageContext);
        updateCache(query, opts._cacheOpts, {
          results: betterResults,
          partial: finalStats.pending.length > 0 || finalStats.failed.length > 0 || finalStats.skipped.length > 0,
          engineStats: finalStats,
          elapsed_ms: Date.now() - startTime,
          intent,
          locale: languageContext.locale,
          language: languageContext.language,
        });
        console.error(`[merger] background update: ${betterResults.length} results`);
      }
    });
  }

  return {
    results: fastPathResults,
    partial: fastPathStats.pending.length > 0 || fastPathStats.failed.length > 0 || fastPathStats.skipped.length > 0,
    engineStats: fastPathStats,
    elapsed_ms: fastPathElapsed,
    intent,
    locale: languageContext.locale,
    language: languageContext.language,
    background: opts.includeBackgroundPromise ? backgroundPromise : undefined,
  };
}

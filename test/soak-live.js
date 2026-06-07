/**
 * Live runSearch soak test.
 *
 * Runtime controls:
 *   SOAK_QUERY_COUNT=5
 *   SOAK_QUERY_TIMEOUT_MS=20000
 *   SOAK_TOTAL_TIMEOUT_MS=<derived from query count>
 *
 * Run:
 *   npm run test:soak
 */

import { closeBrowser } from '../src/browser.js';
import { runSearch } from '../src/merger.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

const QUERIES = [
  { query: 'nodejs documentation', intent: 'docs' },
  { query: 'github playwright examples', intent: 'code' },
  { query: 'reddit ollama local llm opinions', intent: 'discussion' },
  { query: 'what is retrieval augmented generation', intent: 'factual' },
  { query: 'best sqlite backup strategy', intent: 'general' },
  { query: 'typescript handbook narrowing', intent: 'docs' },
  { query: 'rust tokio tutorial', intent: 'docs' },
  { query: 'python requests library github', intent: 'code' },
  { query: 'history of search engines', intent: 'factual' },
  { query: 'postgres indexing guide', intent: 'docs' },
];

const queryCount = intFromEnv('SOAK_QUERY_COUNT', 5, { min: 1, max: QUERIES.length });
const queryTimeoutMs = intFromEnv('SOAK_QUERY_TIMEOUT_MS', 20_000, { min: 1_000, max: 120_000 });
const totalTimeoutMs = intFromEnv('SOAK_TOTAL_TIMEOUT_MS', queryCount * queryTimeoutMs + 5_000, {
  min: queryTimeoutMs,
  max: 15 * 60_000,
});

const selectedQueries = QUERIES.slice(0, queryCount);
const startedAt = Date.now();
const outcomes = [];
const degradationCounts = new Map();
const failures = [];

function intFromEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function typedDegradation(kind, message) {
  return { status: 'degraded', kind, message };
}

function classifyProviderDegradation(input) {
  const message = String(input?.message || input || '');
  const lower = message.toLowerCase();
  const state = String(input?.state || input?.code || '').toLowerCase();

  if (state && ['cooldown', 'blocked', 'rate_limited', 'auth_missing', 'auth_failed', 'empty_suspect'].includes(state)) {
    return typedDegradation(state, message || state);
  }
  if (/\bchallenge page\b|\bcaptcha\b|captcha cooldown|in captcha cooldown|checking your browser/.test(lower)) {
    return typedDegradation('challenge', message);
  }
  if (/\bblocked\b|verify you are human|unusual traffic|automated queries/.test(lower)) {
    return typedDegradation('blocked', message);
  }
  if (/rate limited|cooling down|cooldown active|http (403|429)\b/.test(lower)) {
    return typedDegradation('rate_limited', message);
  }
  if (/\bconsent page\b|cookies/.test(lower)) {
    return typedDegradation('consent_required', message);
  }
  if (/empty_suspect|selector_miss|known-positive query returned no extractable results|0 results/.test(lower)) {
    return typedDegradation('selector_miss', message);
  }
  return null;
}

function collectDegradations(stats = {}) {
  const typed = [];
  const unknown = [];
  const health = stats.health || {};

  for (const engine of stats.failed || []) {
    const message = stats.errors?.[engine] || health[engine]?.reason || 'failed';
    const degraded = classifyProviderDegradation({
      message,
      state: health[engine]?.state,
      code: health[engine]?.state,
    });
    if (degraded) {
      typed.push({ engine, ...degraded });
    } else {
      unknown.push({ engine, message });
    }
  }

  for (const item of stats.skipped || []) {
    typed.push({
      engine: item.engine,
      ...typedDegradation(item.state || 'skipped', item.reason || item.state || 'skipped'),
    });
  }

  for (const engine of stats.pending || []) {
    typed.push({
      engine,
      ...typedDegradation('pending', 'engine did not finish before fast-path response'),
    });
  }

  return { typed, unknown };
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function runOne({ query, intent }, index) {
  const start = Date.now();
  const result = await withTimeout(
    runSearch(query, { limit: 8, intent, awaitBackground: true }),
    queryTimeoutMs,
    `query ${index + 1}`,
  );
  const latencyMs = Date.now() - start;
  const resultCount = Array.isArray(result.results) ? result.results.length : 0;
  const processSuccess = result && typeof result === 'object';
  const usefulSuccess = resultCount > 0;
  const { typed, unknown } = collectDegradations(result.engineStats);

  for (const degradation of typed) {
    increment(degradationCounts, `${degradation.engine}:${degradation.kind}`);
  }

  return {
    query,
    intent: result.intent || intent,
    processSuccess,
    usefulSuccess,
    latencyMs,
    resultCount,
    partial: !!result.partial,
    completed: result.engineStats?.completed || [],
    failed: result.engineStats?.failed || [],
    typed,
    unknown,
  };
}

console.log(`${INFO} live soak: queries=${queryCount}, per_query_timeout=${queryTimeoutMs}ms, total_timeout=${totalTimeoutMs}ms`);

for (const [index, item] of selectedQueries.entries()) {
  if (Date.now() - startedAt > totalTimeoutMs) {
    failures.push(`total timeout exceeded before query ${index + 1}`);
    break;
  }

  console.log(`\n${INFO} [${index + 1}/${queryCount}] ${item.query}`);
  try {
    const outcome = await runOne(item, index);
    outcomes.push(outcome);

    if (outcome.unknown.length > 0) {
      failures.push(`untyped failures for "${outcome.query}": ${outcome.unknown.map(item => `${item.engine}:${item.message}`).join(' | ')}`);
    }
    if (!outcome.usefulSuccess && outcome.typed.length === 0) {
      failures.push(`silent failure for "${outcome.query}": 0 results and no typed degradation`);
    }

    const status = outcome.usefulSuccess ? PASS : INFO;
    const degraded = outcome.typed.length ? `, typed_degraded=${outcome.typed.length}` : '';
    console.log(`  ${status} results=${outcome.resultCount}, completed=${outcome.completed.length}, latency=${outcome.latencyMs}ms${degraded}`);
  } catch (err) {
    failures.push(`process failure for "${item.query}": ${err?.message || err}`);
    outcomes.push({
      query: item.query,
      intent: item.intent,
      processSuccess: false,
      usefulSuccess: false,
      latencyMs: Date.now() - startedAt,
      resultCount: 0,
      partial: true,
      completed: [],
      failed: [],
      typed: [],
      unknown: [],
    });
    console.log(`  ${FAIL} ${err?.message || err}`);
  }
}

await closeBrowser();

const latencies = outcomes.filter(item => item.processSuccess).map(item => item.latencyMs);
const processSuccess = outcomes.filter(item => item.processSuccess).length;
const usefulSuccess = outcomes.filter(item => item.usefulSuccess).length;
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const degradationSummary = Object.fromEntries([...degradationCounts.entries()].sort());

console.log(`\n${INFO} soak summary`);
console.log(`  process_success=${processSuccess}/${selectedQueries.length}`);
console.log(`  useful_success=${usefulSuccess}/${selectedQueries.length}`);
console.log(`  latency_p50_ms=${p50}`);
console.log(`  latency_p95_ms=${p95}`);
console.log(`  typed_degradations=${JSON.stringify(degradationSummary)}`);

if (failures.length > 0) {
  console.log(`\n${FAIL} soak failures`);
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`\n${PASS} live soak passed`);
process.exit(0);

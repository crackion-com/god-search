/**
 * Offline response contract tests.
 *
 * Run:
 *   node test/verify-contracts.js
 */

import { APP } from '../src/config.js';
import { buildOpenApiSpec } from '../src/openapi.js';
import { buildSearchResponse } from '../src/response.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed += 1;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

async function runTest(name, fn) {
  console.log(`\n${INFO} ${name}`);
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  }
}

function fixtureResult(overrides = {}) {
  return {
    results: [
      {
        title: 'Result',
        url: 'https://example.com/result',
        snippet: 'snippet',
        score: 10,
        engines: ['ddg'],
        evidence: {
          engines: ['ddg'],
          cross_engine_count: 1,
          domain: 'example.com',
        },
        rank: 1,
      },
    ],
    partial: false,
    elapsed_ms: 123,
    engineStats: {
      attempted: ['ddg'],
      completed: ['ddg'],
      failed: [],
      pending: [],
      skipped: [],
      counts: { ddg: 1 },
      errors: {},
    },
    ...overrides,
  };
}

const cache = {
  size: 1,
  inflight: 0,
  ttl_ms: 600000,
  max_entries: 256,
  hits: 0,
  misses: 0,
  inflightHits: 0,
  writes: 0,
  skippedWrites: 0,
};

await runTest('search response preserves compact default shape', () => {
  const output = buildSearchResponse({
    query: 'agent search',
    result: fixtureResult(),
    verbose: false,
    app: APP,
    cache,
  });

  assert(output.query === 'agent search', 'includes query');
  assert(output.total === 1, 'includes total');
  assert(output.partial === false, 'includes partial flag');
  assert(output.intent === null, 'includes default intent field');
  assert(output.quality.status === 'settled', 'includes default quality status');
  assert(output.quality.quorum_met === true, 'includes default quorum metadata');
  assert(output.results[0].evidence.cross_engine_count === 1, 'includes per-result evidence metadata');
  assert(!Object.prototype.hasOwnProperty.call(output, 'elapsed_ms'), 'omits elapsed_ms unless verbose');
  assert(!Object.prototype.hasOwnProperty.call(output, 'engines'), 'omits engines unless verbose');
  assert(output.quality.status === 'settled', 'default quality status is settled');
  assert(output.quality.quorum_met === true, 'default quality marks quorum met when results exist');
  assert(Array.isArray(output.quality.degradation_reasons) && output.quality.degradation_reasons.length === 0, 'default quality has no degradation reasons');
  assert(Array.isArray(output.quality.reason_codes) && output.quality.reason_codes.length === 0, 'default quality has no reason codes');
  assert(output.quality.retry_after_ms === 0, 'default quality has zero retry delay');
  assert(output.results[0].evidence.engines.join(',') === 'ddg', 'adds default result evidence engines');
  assert(output.results[0].evidence.cross_engine_count === 1, 'adds default result evidence count');
  assert(output.meta.app.name === APP.name, 'includes app metadata');
  assert(output.meta.cache === cache, 'includes supplied cache metadata');
});

await runTest('search response preserves explicit per-result evidence metadata', () => {
  const output = buildSearchResponse({
    query: 'evidence',
    result: fixtureResult({
      results: [{
        title: 'Evidence result',
        url: 'https://docs.example.com/page',
        snippet: 'snippet',
        score: 18,
        engines: ['ddg', 'google'],
        evidence: {
          engines: ['ddg', 'google'],
          cross_engine_count: 2,
          domain: 'example.com',
        },
        rank: 1,
      }],
    }),
    verbose: false,
    app: APP,
    cache,
  });

  assert(output.results[0].evidence.domain === 'example.com', 'preserves evidence domain');
  assert(output.results[0].evidence.cross_engine_count === 2, 'preserves cross-engine evidence count');
  assert(output.results[0].evidence.engines.join(',') === 'ddg,google', 'preserves evidence engines');
});

await runTest('search response exposes verbose, cached, empty, and degraded states', () => {
  const degraded = fixtureResult({
    fromCache: true,
    partial: true,
    results: [],
    engineStats: {
      attempted: ['ddg', 'reddit'],
      completed: [],
      failed: ['reddit'],
      pending: ['ddg'],
      skipped: [{ engine: 'brave', state: 'blocked', reason: 'challenge page', retry_after_ms: 30000 }],
      counts: { reddit: 0 },
      errors: { reddit: 'HTTP 429' },
    },
  });

  const output = buildSearchResponse({
    query: 'degraded',
    result: degraded,
    verbose: true,
    app: APP,
    cache,
  });

  assert(output.total === 0, 'empty result total is zero');
  assert(output.cached === true, 'cached flag is included');
  assert(output.partial === true, 'partial flag is included');
  assert(output.quality.status === 'failed', 'quality reports failed when partial response has no results');
  assert(output.quality.quorum_met === false, 'quality quorum is false without results');
  assert(output.quality.degradation_reasons.includes('reddit: HTTP 429'), 'quality includes failed engine reason');
  assert(output.quality.degradation_reasons.includes('ddg: pending'), 'quality includes pending engine reason');
  assert(output.quality.reason_codes.includes('reddit:failed'), 'quality includes failed reason code');
  assert(output.quality.reason_codes.includes('ddg:pending'), 'quality includes pending reason code');
  assert(output.elapsed_ms === 123, 'verbose includes elapsed_ms');
  assert(output.engines.failed.includes('reddit'), 'verbose includes failed engine metadata');
  assert(output.engines.pending.includes('ddg'), 'verbose includes pending engine metadata');
  assert(output.engines.errors.reddit === 'HTTP 429', 'verbose includes engine errors');
  assert(output.quality.status === 'failed', 'degraded empty response reports failed status');
  assert(output.quality.retry_after_ms === 30000, 'quality exposes retry-after metadata');
  assert(output.quality.degradation_reasons.some(reason => reason.includes('reddit')), 'quality includes failed degradation reason');
  assert(output.quality.degradation_reasons.some(reason => reason.includes('brave')), 'quality includes skipped degradation reason');
});

await runTest('OpenAPI request contract exposes supported engines and bounds', () => {
  const spec = buildOpenApiSpec();
  const searchSchema = spec.paths['/search'].post.requestBody.content['application/json'].schema;
  const engineEnum = searchSchema.properties.engines.items.enum;

  assert(searchSchema.required.includes('query'), 'OpenAPI requires query');
  assert(searchSchema.properties.limit.minimum === 1, 'OpenAPI limit minimum is 1');
  assert(searchSchema.properties.limit.maximum === 20, 'OpenAPI limit maximum is 20');
  assert(engineEnum.join(',') === 'official,ddg,bing,brave,google,reddit,github,stackoverflow,hackernews,npm,wikipedia', 'OpenAPI exposes supported engine enum', engineEnum.join(','));
});

console.log(`\n${'-'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('-'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

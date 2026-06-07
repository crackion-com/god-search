/**
 * Deterministic runSearch async behavior tests.
 *
 * Run:
 *   node test/verify-run-search.js
 */

import {
  __resetForTests as resetCacheForTests,
  cacheStats,
  withCache,
} from '../src/cache.js';
import { runSearch } from '../src/merger.js';
import {
  __resetProviderHealthForTests,
  providerSnapshot,
} from '../src/provider-health.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;
let seq = 0;

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
    resetCacheForTests();
    __resetProviderHealthForTests();
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  }
}

function uniqueQuery(label) {
  seq += 1;
  return `run-search-${Date.now()}-${seq}-${label}`;
}

function result(engine, index = 1, url = `https://nodejs.org/docs/${engine}-${index}`) {
  return {
    title: `Node.js ${engine} docs ${index}`,
    url,
    snippet: `Official Node.js documentation from ${engine} with enough detail to score well.`,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function engineFns(overrides) {
  return Object.fromEntries(
    Object.entries(overrides).map(([name, value]) => [
      name,
      typeof value === 'function' ? value : async () => value,
    ]),
  );
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

await runTest('fast path returns pending engine stats before slow engines finish', async () => {
  const slow = deferred();
  const query = `${uniqueQuery('fast-path-pending')} nodejs documentation`;

  const search = await runSearch(query, {
    limit: 5,
    engines: ['ddg', 'google', 'bing', 'github'],
    _engineFns: engineFns({
      ddg: [result('ddg')],
      google: [result('google')],
      bing: [result('bing')],
      github: () => slow.promise,
    }),
  });

  assert(search.partial === true, 'fast-path response is marked partial');
  assert(search.engineStats.completed.join(',') === 'ddg,google,bing', 'completed engines are reported');
  assert(search.engineStats.pending.join(',') === 'github', 'slow engine remains pending');
  assert(search.engineStats.failed.length === 0, 'no failures are reported');
  assert(search.results.length > 0, 'fast path returns merged results');

  slow.resolve([result('github')]);
  await flushMicrotasks();
});

await runTest('engine failures are captured without failing the search', async () => {
  const query = uniqueQuery('failure');

  const search = await runSearch(query, {
    limit: 5,
    engines: ['ddg', 'google'],
    _engineFns: engineFns({
      ddg: [result('ddg')],
      google: async () => {
        throw new Error('planned google failure');
      },
    }),
  });

  assert(search.partial === true, 'failed engine marks response partial');
  assert(search.engineStats.completed.join(',') === 'ddg', 'successful engine is completed');
  assert(search.engineStats.failed.join(',') === 'google', 'failed engine is reported');
  assert(search.engineStats.errors.google === 'planned google failure', 'failure message is preserved');
  assert(search.engineStats.pending.length === 0, 'fully settled response has no pending engines');
  assert(providerSnapshot('google').state === 'failed', 'provider health records failed engine');
});

await runTest('health-aware routing skips engines in cooldown on default plans', async () => {
  const query = `${uniqueQuery('cooldown-skip')} nodejs documentation`;

  await runSearch(query, {
    limit: 5,
    engines: ['ddg', 'google'],
    _engineFns: engineFns({
      ddg: [result('ddg')],
      google: async () => {
        throw new Error('Google challenge page');
      },
    }),
  });

  const skippedSearch = await runSearch(query, {
    limit: 5,
    intent: 'docs',
    searchConfig: { enableBraveByDefault: false },
    _engineFns: engineFns({
      ddg: [result('ddg')],
      bing: [result('bing')],
      github: [result('github')],
      wikipedia: [result('wikipedia')],
      reddit: [result('reddit')],
    }),
  });

  assert(skippedSearch.engineStats.skipped.some(item => item.engine === 'google'), 'cooldown engine is skipped');
  assert(skippedSearch.engineStats.pending.includes('google') === false, 'skipped engine is not pending');
  assert(skippedSearch.partial === true, 'skipped engine marks response partial');
});

await runTest('awaitBackground waits for slow engines and returns final stats', async () => {
  const query = `${uniqueQuery('await-background')} nodejs documentation`;

  const search = await runSearch(query, {
    limit: 5,
    engines: ['ddg', 'google', 'bing', 'github'],
    awaitBackground: true,
    _engineFns: engineFns({
      ddg: [result('ddg')],
      google: [result('google')],
      bing: [result('bing')],
      github: async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return [result('github', 1, 'https://github.com/nodejs/node')];
      },
    }),
  });

  assert(search.partial === false, 'final response is not partial when all engines succeed');
  assert(search.engineStats.pending.length === 0, 'final stats have no pending engines');
  assert(search.engineStats.completed.includes('github'), 'slow engine is completed in final stats');
  assert(search.results.some(item => item.url.includes('github.com/nodejs/node')), 'final results include slow engine contribution');
});

await runTest('background completion updates the cache with better final stats', async () => {
  const slow = deferred();
  const query = `${uniqueQuery('background-cache')} nodejs documentation`;
  const cacheOpts = { limit: 5, engines: ['ddg', 'google', 'bing', 'github'] };

  const first = await runSearch(query, {
    ...cacheOpts,
    _cacheOpts: cacheOpts,
    _engineFns: engineFns({
      ddg: [result('ddg')],
      google: [result('google')],
      bing: [result('bing')],
      github: () => slow.promise,
    }),
  });

  assert(first.engineStats.pending.join(',') === 'github', 'initial response leaves github pending');
  assert(cacheStats().size === 0, 'cache is not updated before background completion');

  slow.resolve([result('github', 1, 'https://github.com/nodejs/node')]);
  await flushMicrotasks();

  const cached = await withCache(query, cacheOpts, async () => {
    throw new Error('cache miss after background update');
  });

  assert(cached.fromCache === true, 'background result is served from cache');
  assert(cached.engineStats.pending.length === 0, 'cached result has final pending stats');
  assert(cached.engineStats.completed.includes('github'), 'cached result includes slow engine completion');
  assert(cached.results.some(item => item.url.includes('github.com/nodejs/node')), 'cached result includes slow engine result');
});

const stats = cacheStats();
console.log(`\n${INFO} cache stats: size=${stats.size}, hits=${stats.hits}, misses=${stats.misses}, writes=${stats.writes}, skipped=${stats.skippedWrites}`);
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

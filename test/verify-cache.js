/**
 * Deterministic cache contract tests.
 *
 * Run:
 *   node test/verify-cache.js
 */

import {
  __resetForTests as resetCacheForTests,
  __setNowForTests,
  cacheStats,
  updateCache,
  withCache,
} from '../src/cache.js';

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
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  }
}

function uniqueQuery(label) {
  seq += 1;
  return `cache-contract-${Date.now()}-${seq}-${label}`;
}

function result({ partial = false, count = 1, status = 'success', noCache = false } = {}) {
  return {
    status,
    partial,
    noCache,
    results: Array.from({ length: count }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      snippet: 'cached result',
    })),
  };
}

async function expectCached(query, opts, value) {
  let calls = 0;
  const first = await withCache(query, opts, async () => {
    calls += 1;
    return value;
  });
  const second = await withCache(query, opts, async () => {
    calls += 1;
    return result({ count: 99 });
  });

  assert(first.fromCache !== true, 'first response is live');
  assert(second.fromCache === true, 'second response is cached');
  assert(calls === 1, `loader called once`, `called ${calls}`);
}

async function expectNotCached(query, opts, value) {
  let calls = 0;
  await withCache(query, opts, async () => {
    calls += 1;
    return value;
  });
  const second = await withCache(query, opts, async () => {
    calls += 1;
    return result({ count: 2 });
  });

  assert(second.fromCache !== true, 'second response is live, not cached');
  assert(calls === 2, 'loader called twice', `called ${calls}`);
}

await runTest('caches complete successful responses', async () => {
  await expectCached(uniqueQuery('complete'), { limit: 10 }, result({ count: 2 }));
});

await runTest('does not cache explicit noCache responses', async () => {
  await expectNotCached(uniqueQuery('nocache'), { limit: 10 }, result({ noCache: true }));
});

await runTest('does not cache blocked or failed-only responses', async () => {
  await expectNotCached(uniqueQuery('blocked'), { limit: 10 }, result({ status: 'blocked', count: 0 }));
  await expectNotCached(uniqueQuery('failed'), { limit: 10 }, result({ status: 'failed', count: 0 }));
  await expectNotCached(uniqueQuery('consent'), { limit: 10 }, result({ status: 'consent', count: 0 }));
});

await runTest('does not cache tiny partial responses', async () => {
  await expectNotCached(uniqueQuery('tiny-partial'), { limit: 10 }, result({ partial: true, count: 2 }));
});

await runTest('caches useful partial responses at the result floor', async () => {
  await expectCached(uniqueQuery('useful-partial'), { limit: 10 }, result({ partial: true, count: 3 }));
});

await runTest('uses the request limit as the partial floor when lower than three', async () => {
  await expectCached(uniqueQuery('limit-one-partial'), { limit: 1 }, result({ partial: true, count: 1 }));
  await expectCached(uniqueQuery('limit-two-partial'), { limit: 2 }, result({ partial: true, count: 2 }));
});

await runTest('deduplicates concurrent inflight work', async () => {
  const query = uniqueQuery('inflight');
  let calls = 0;

  const [a, b] = await Promise.all([
    withCache(query, { limit: 5 }, async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return result({ count: 1 });
    }),
    withCache(query, { limit: 5 }, async () => {
      calls += 1;
      return result({ count: 2 });
    }),
  ]);

  assert(calls === 1, 'loader called once for concurrent requests', `called ${calls}`);
  assert(a.results.length === b.results.length, 'concurrent callers share the same result');
});

await runTest('expires cached entries after TTL', async () => {
  const query = uniqueQuery('ttl');
  let now = 1_000;
  let calls = 0;

  __setNowForTests(() => now);
  await withCache(query, { limit: 5 }, async () => {
    calls += 1;
    return result({ count: 1 });
  });

  now += cacheStats().ttl_ms + 1;
  const second = await withCache(query, { limit: 5 }, async () => {
    calls += 1;
    return result({ count: 2 });
  });

  assert(second.fromCache !== true, 'expired entry is not served from cache');
  assert(second.results.length === 2, 'expired entry is replaced with fresh result');
  assert(calls === 2, 'loader runs again after TTL expiry', `called ${calls}`);
});

await runTest('evicts least-recently-used entries when full', async () => {
  const maxEntries = cacheStats().max_entries;
  const queries = Array.from({ length: maxEntries }, (_, index) => uniqueQuery(`lru-${index}`));

  for (const [index, query] of queries.entries()) {
    await withCache(query, { limit: 5 }, async () => {
      const value = result({ count: 1 });
      value.marker = `value-${index}`;
      return value;
    });
  }

  const touched = await withCache(queries[0], { limit: 5 }, async () => result({ count: 99 }));
  assert(touched.fromCache === true, 'oldest entry can be promoted before eviction');
  assert(touched.marker === 'value-0', 'promoted entry keeps original value');

  await withCache(uniqueQuery('lru-new'), { limit: 5 }, async () => result({ count: 1 }));

  let q0Calls = 0;
  const stillCached = await withCache(queries[0], { limit: 5 }, async () => {
    q0Calls += 1;
    return result({ count: 99 });
  });

  let q1Calls = 0;
  const evicted = await withCache(queries[1], { limit: 5 }, async () => {
    q1Calls += 1;
    const value = result({ count: 2 });
    value.marker = 'fresh-after-evict';
    return value;
  });

  assert(stillCached.fromCache === true, 'recently used entry survives LRU eviction');
  assert(q0Calls === 0, 'loader skipped for recently used entry', `called ${q0Calls}`);
  assert(evicted.fromCache !== true, 'least-recently-used entry is evicted');
  assert(evicted.marker === 'fresh-after-evict', 'evicted entry is recomputed');
  assert(q1Calls === 1, 'loader runs for evicted entry', `called ${q1Calls}`);
  assert(cacheStats().size === maxEntries, 'cache remains capped at max entries');
});

await runTest('canonicalizes query text and engine order into stable keys', async () => {
  let calls = 0;
  await withCache('  Mixed Case Query  ', { engines: ['google', 'bing'], limit: 7 }, async () => {
    calls += 1;
    const value = result({ count: 1 });
    value.marker = 'canonical';
    return value;
  });

  const cached = await withCache('mixed case query', { engines: ['bing', 'google'], limit: 7 }, async () => {
    calls += 1;
    return result({ count: 99 });
  });

  assert(cached.fromCache === true, 'canonical equivalent request is cached');
  assert(cached.marker === 'canonical', 'canonical request returns original cached value');
  assert(calls === 1, 'loader called once for canonical equivalents', `called ${calls}`);
});

await runTest('clears rejected inflight work so retries can run', async () => {
  const query = uniqueQuery('rejected-inflight');
  let calls = 0;

  await withCache(query, { limit: 5 }, async () => {
    calls += 1;
    throw new Error('planned failure');
  }).catch(() => null);

  const retry = await withCache(query, { limit: 5 }, async () => {
    calls += 1;
    return result({ count: 2 });
  });

  assert(retry.fromCache !== true, 'retry after rejection is live');
  assert(retry.results.length === 2, 'retry returns successful result');
  assert(calls === 2, 'loader runs again after rejected inflight', `called ${calls}`);
  assert(cacheStats().inflight === 0, 'rejected inflight entry is cleared');
});

await runTest('deduplicates no-cache inflight work without caching the result', async () => {
  const query = uniqueQuery('nocache-inflight');
  let calls = 0;

  const [a, b] = await Promise.all([
    withCache(query, { limit: 5 }, async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return result({ noCache: true, count: 1 });
    }),
    withCache(query, { limit: 5 }, async () => {
      calls += 1;
      return result({ count: 99 });
    }),
  ]);

  const third = await withCache(query, { limit: 5 }, async () => {
    calls += 1;
    return result({ count: 2 });
  });

  assert(calls === 2, 'concurrent no-cache work is shared, later work reruns', `called ${calls}`);
  assert(a.results.length === b.results.length, 'concurrent no-cache callers share result');
  assert(third.fromCache !== true, 'no-cache inflight result is not cached afterward');
  assert(third.results.length === 2, 'later no-cache request gets fresh result');
});

await runTest('manual cache updates honor cacheability rules', async () => {
  const blockedQuery = uniqueQuery('manual-blocked');
  updateCache(blockedQuery, { limit: 10 }, result({ status: 'blocked', count: 0 }));
  let blockedCalls = 0;
  const blockedCheck = await withCache(blockedQuery, { limit: 10 }, async () => {
    blockedCalls += 1;
    return result({ count: 1 });
  });
  assert(blockedCheck.fromCache !== true, 'blocked manual update is not cached');
  assert(blockedCalls === 1, 'loader runs after blocked manual update', `called ${blockedCalls}`);

  const usefulQuery = uniqueQuery('manual-useful');
  updateCache(usefulQuery, { limit: 10 }, result({ partial: true, count: 3 }));
  let calls = 0;
  const cached = await withCache(usefulQuery, { limit: 10 }, async () => {
    calls += 1;
    return result({ count: 1 });
  });
  assert(cached.fromCache === true, 'useful manual update is cached');
  assert(calls === 0, 'loader skipped after useful manual update', `called ${calls}`);
});

await runTest('manual low-value update does not replace a good cached result', async () => {
  const query = uniqueQuery('manual-preserve-good');
  const goodValue = result({ count: 2 });
  goodValue.marker = 'good';

  updateCache(query, { limit: 10 }, goodValue);
  updateCache(query, { limit: 10 }, result({ partial: true, count: 1 }));

  let calls = 0;
  const cached = await withCache(query, { limit: 10 }, async () => {
    calls += 1;
    return result({ count: 1 });
  });

  assert(cached.fromCache === true, 'good cached result is still served');
  assert(cached.marker === 'good', 'bad manual update did not overwrite good result');
  assert(calls === 0, 'loader skipped because good cached result remained', `called ${calls}`);
});

const stats = cacheStats();
console.log(`\n${INFO} cache stats: size=${stats.size}, hits=${stats.hits}, misses=${stats.misses}, writes=${stats.writes}, skipped=${stats.skippedWrites}`);
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

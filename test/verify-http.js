/**
 * Deterministic HTTP contract tests.
 *
 * Run:
 *   node test/verify-http.js
 */

import { createHttpServer } from '../src/http.js';
import { EventEmitter } from 'node:events';

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

function noop() {}

function baseDeps(overrides = {}) {
  return {
    browserStatus: () => ({ connected: false, pages: 0 }),
    cacheStats: () => ({ size: 0, hits: 0, misses: 0 }),
    runtime: {
      noteError: noop,
      noteExtractComplete: noop,
      noteExtractStart: noop,
      noteHealthRequest: noop,
      noteSearchComplete: noop,
      noteSearchStart: noop,
      runtimeSnapshot: () => ({ requests: 0, errors: 0 }),
    },
    ...overrides,
  };
}

function searchResult(overrides = {}) {
  return {
    results: [
      {
        title: 'Injected result',
        url: 'https://example.com/result',
        snippet: 'deterministic snippet',
        score: 12,
        engines: ['ddg'],
        rank: 1,
      },
    ],
    partial: false,
    elapsed_ms: 42,
    engineStats: {
      attempted: ['ddg'],
      completed: ['ddg'],
      failed: [],
      pending: [],
      counts: { ddg: 1 },
      errors: {},
    },
    ...overrides,
  };
}

async function withServer(deps, fn) {
  const server = createHttpServer(deps);
  const handler = server.listeners('request')[0];
  await fn(handler);
}

async function request(handler, path, { method = 'GET', body, rawBody } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;

  let status = 0;
  let text = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(payload) {
      text = payload || '';
      res.resolve();
    },
  };
  const done = new Promise(resolve => {
    res.resolve = resolve;
  });

  const run = handler(req, res);
  queueMicrotask(() => {
    const payload = rawBody ?? (body ? JSON.stringify(body) : '');
    if (payload) req.emit('data', payload);
    req.emit('end');
  });

  await Promise.all([Promise.resolve(run), done]);
  return {
    status,
    body: text ? JSON.parse(text) : null,
  };
}

const originalConsoleError = console.error;
console.error = () => {};

await runTest('health returns injected readiness metadata', async () => {
  let healthRequests = 0;

  await withServer(baseDeps({
    browserStatus: () => ({ connected: true, pages: 2 }),
    cacheStats: () => ({ size: 3, hits: 4, misses: 5 }),
    runtime: {
      ...baseDeps().runtime,
      noteHealthRequest: () => { healthRequests += 1; },
      runtimeSnapshot: () => ({ requests: 9, errors: 0 }),
    },
  }), async handler => {
    const res = await request(handler, '/health');
    assert(res.status === 200, 'status is 200');
    assert(res.body.status === 'ok', 'body status is ok');
    assert(res.body.ready === true, 'ready is true');
    assert(res.body.browser.connected === true, 'uses injected browser status');
    assert(res.body.cache.size === 3, 'uses injected cache stats');
    assert(res.body.runtime.requests === 9, 'uses injected runtime snapshot');
    assert(healthRequests === 1, 'records health request');
  });
});

await runTest('openapi exposes generated spec', async () => {
  await withServer(baseDeps(), async handler => {
    const res = await request(handler, '/openapi.json');
    assert(res.status === 200, 'status is 200');
    assert(res.body.openapi === '3.1.0', 'returns OpenAPI 3.1 spec');
    assert(Boolean(res.body.paths?.['/search']?.post), 'includes search path');
    assert(Boolean(res.body.paths?.['/extract']?.post), 'includes extract path');
  });
});

await runTest('search rejects missing query', async () => {
  await withServer(baseDeps(), async handler => {
    const res = await request(handler, '/search', { method: 'POST', body: { limit: 1 } });
    assert(res.status === 400, 'status is 400');
    assert(res.body.error === 'query is required', 'returns query validation error');
  });
});

await runTest('search returns 500 when dependency fails', async () => {
  await withServer(baseDeps({
    withCache: async () => {
      throw new Error('search failed');
    },
  }), async handler => {
    const res = await request(handler, '/search', {
      method: 'POST',
      body: { query: 'failure' },
    });
    assert(res.status === 500, 'status is 500');
    assert(res.body.error === 'search failed', 'returns search error message');
  });
});

await runTest('search returns verbose success response', async () => {
  const calls = [];

  await withServer(baseDeps({
    withCache: async (query, opts, loader) => {
      calls.push({ type: 'cache', query, opts });
      return loader();
    },
    runSearch: async (query, opts) => {
      calls.push({ type: 'search', query, opts });
      return searchResult();
    },
  }), async handler => {
    const res = await request(handler, '/search', {
      method: 'POST',
      body: { query: 'contract', limit: 2, engines: ['ddg'], verbose: true },
    });
    assert(res.status === 200, 'status is 200');
    assert(res.body.query === 'contract', 'includes query');
    assert(res.body.total === 1, 'includes total');
    assert(res.body.quality.status === 'settled', 'includes default quality metadata');
    assert(res.body.quality.quorum_met === true, 'quality marks quorum met');
    assert(res.body.results[0].evidence.engines.join(',') === 'ddg', 'includes per-result evidence engines');
    assert(res.body.results[0].evidence.cross_engine_count === 1, 'includes per-result evidence count');
    assert(res.body.elapsed_ms === 42, 'verbose includes elapsed_ms');
    assert(res.body.engines.completed.includes('ddg'), 'verbose includes engine metadata');
    assert(calls[0].type === 'cache' && calls[0].opts.limit === 2, 'uses injected cache wrapper');
    assert(calls[1].type === 'search' && calls[1].opts._cacheOpts === calls[0].opts, 'passes cache options to search');
  });
});

await runTest('extract rejects missing url', async () => {
  await withServer(baseDeps(), async handler => {
    const res = await request(handler, '/extract', { method: 'POST', body: {} });
    assert(res.status === 400, 'status is 400');
    assert(res.body.error === 'url is required', 'returns url validation error');
  });
});

await runTest('extract returns 500 when dependency fails', async () => {
  await withServer(baseDeps({
    extract: async () => {
      throw new Error('extract failed\nwith details');
    },
  }), async handler => {
    const res = await request(handler, '/extract', {
      method: 'POST',
      body: { url: 'https://example.com/fail' },
    });
    assert(res.status === 500, 'status is 500');
    assert(res.body.error === 'Extract failed: extract failed', 'normalizes extract error message');
  });
});

await runTest('extract returns success response with app metadata', async () => {
  let target = '';

  await withServer(baseDeps({
    extract: async url => {
      target = url;
      return {
        url,
        title: 'Example',
        text: 'Extracted page text',
      };
    },
  }), async handler => {
    const res = await request(handler, '/extract', {
      method: 'POST',
      body: { url: 'https://example.com/page' },
    });
    assert(res.status === 200, 'status is 200');
    assert(target === 'https://example.com/page', 'passes target url to extractor');
    assert(res.body.title === 'Example', 'returns extraction payload');
    assert(res.body.meta.app.name === 'god-search', 'adds app metadata');
  });
});

await runTest('unknown route returns 404', async () => {
  await withServer(baseDeps(), async handler => {
    const res = await request(handler, '/missing');
    assert(res.status === 404, 'status is 404');
    assert(res.body.error === 'Not found', 'returns not found error');
    assert(res.body.routes.includes('GET /health'), 'includes route hints');
  });
});

console.error = originalConsoleError;

console.log(`\n${'-'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('-'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

/**
 * Deterministic MCP handler contract tests.
 *
 * Run:
 *   node test/verify-mcp.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createMcpServer,
  handleGodExtract,
  handleGodHealth,
  handleGodSearch,
} from '../src/mcp.js';

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

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function noop() {}

function baseDeps(overrides = {}) {
  return {
    app: { name: 'god-search', version: 'test', description: 'test app' },
    version: 'test',
    cacheStats: () => ({ size: 0, hits: 0, misses: 0 }),
    browserStatus: () => ({ connected: false }),
    runtimeSnapshot: () => ({ requests: { search: 0, extract: 0, health: 0 } }),
    noteError: noop,
    noteExtractComplete: noop,
    noteExtractStart: noop,
    noteHealthRequest: noop,
    noteSearchComplete: noop,
    noteSearchStart: noop,
    logger: { error: noop },
    ...overrides,
  };
}

function searchResult(overrides = {}) {
  return {
    results: [{
      title: 'MCP Result',
      url: 'https://example.com/mcp',
      snippet: 'snippet',
      score: 10,
      engines: ['ddg'],
      rank: 1,
    }],
    partial: false,
    elapsed_ms: 25,
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

class MemoryTransport {
  constructor() {
    this.sent = [];
  }

  async start() {}

  async send(message) {
    this.sent.push(message);
    await Promise.resolve();
    this.peer?.onmessage?.(message);
  }

  async close() {
    this.onclose?.();
  }
}

function createTransportPair() {
  const clientTransport = new MemoryTransport();
  const serverTransport = new MemoryTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
}

await runTest('god_search handler returns compact and verbose JSON payloads', async () => {
  const calls = [];
  const deps = baseDeps({
    withCache: async (query, opts, loader) => {
      calls.push({ type: 'cache', query, opts });
      return loader();
    },
    runSearch: async (query, opts) => {
      calls.push({ type: 'search', query, opts });
      return searchResult();
    },
  });

  const compact = parseToolResult(await handleGodSearch({ query: 'mcp query', limit: 2, engines: ['ddg'] }, deps));
  const verbose = parseToolResult(await handleGodSearch({ query: 'mcp query', limit: 2, engines: ['ddg'], verbose: true }, deps));

  assert(compact.query === 'mcp query', 'compact payload includes query');
  assert(compact.total === 1, 'compact payload includes total');
  assert(compact.quality.status === 'settled', 'compact payload includes default quality metadata');
  assert(compact.quality.quorum_met === true, 'compact payload marks quorum met');
  assert(compact.results[0].evidence.engines.join(',') === 'ddg', 'compact payload includes result evidence engines');
  assert(compact.results[0].evidence.cross_engine_count === 1, 'compact payload includes result evidence count');
  assert(!Object.prototype.hasOwnProperty.call(compact, 'elapsed_ms'), 'compact payload omits elapsed_ms');
  assert(verbose.elapsed_ms === 25, 'verbose payload includes elapsed_ms');
  assert(verbose.engines.completed.includes('ddg'), 'verbose payload includes engine stats');
  assert(calls[0].type === 'cache' && calls[0].opts.limit === 2, 'cache options are forwarded');
  assert(calls[1].type === 'search' && calls[1].opts._cacheOpts === calls[0].opts, 'search receives cache opts');
});

await runTest('god_search handler returns MCP error payload on failure', async () => {
  const result = await handleGodSearch({ query: 'fail' }, baseDeps({
    withCache: async () => { throw new Error('search exploded'); },
  }));
  const payload = parseToolResult(result);

  assert(result.isError === true, 'marks failed search as MCP error');
  assert(payload.query === 'fail', 'error payload keeps query');
  assert(payload.results.length === 0, 'error payload uses empty results');
  assert(!Object.prototype.hasOwnProperty.call(payload, 'quality'), 'error payload omits success quality metadata');
  assert(payload.error === 'search exploded', 'error payload includes message');
});

await runTest('god_extract handler returns extraction payload and errors', async () => {
  let extractedUrl = '';
  const ok = await handleGodExtract({ url: 'https://example.com/page' }, baseDeps({
    extractPage: async url => {
      extractedUrl = url;
      return { url, title: 'Page', text: 'Body' };
    },
  }));
  const okPayload = parseToolResult(ok);

  const bad = await handleGodExtract({ url: 'https://example.com/bad' }, baseDeps({
    extractPage: async () => { throw new Error('extract exploded'); },
  }));
  const badPayload = parseToolResult(bad);

  assert(extractedUrl === 'https://example.com/page', 'passes URL to extractor');
  assert(okPayload.title === 'Page', 'returns extraction payload');
  assert(okPayload.meta.app.name === 'god-search', 'adds app metadata');
  assert(bad.isError === true, 'marks failed extract as MCP error');
  assert(badPayload.error === 'extract exploded', 'extract error payload includes message');
});

await runTest('god_health handler returns health payload and errors', async () => {
  let healthRequests = 0;
  const ok = await handleGodHealth({}, baseDeps({
    noteHealthRequest: () => { healthRequests += 1; },
    browserStatus: () => ({ connected: true }),
    cacheStats: () => ({ size: 5 }),
    runtimeSnapshot: () => ({ requests: { health: 1 } }),
  }));
  const okPayload = parseToolResult(ok);

  const bad = await handleGodHealth({}, baseDeps({
    browserStatus: () => { throw new Error('browser status failed'); },
  }));
  const badPayload = parseToolResult(bad);

  assert(okPayload.status === 'ok', 'health status is ok');
  assert(okPayload.browser.connected === true, 'health includes browser status');
  assert(okPayload.cache.size === 5, 'health includes cache stats');
  assert(healthRequests === 1, 'records health request');
  assert(bad.isError === true, 'marks health failure as MCP error');
  assert(badPayload.error === 'browser status failed', 'health error payload includes message');
});

await runTest('createMcpServer returns a server for enabled and disabled health tool modes', async () => {
  const withHealth = createMcpServer(baseDeps({ exposeGodHealthTool: true }));
  const withoutHealth = createMcpServer(baseDeps({ exposeGodHealthTool: false }));

  assert(Boolean(withHealth), 'creates MCP server with health tool enabled');
  assert(Boolean(withoutHealth), 'creates MCP server with health tool disabled');
});

await runTest('createMcpServer registers callable tools over an in-memory SDK transport', async () => {
  const deps = baseDeps({
    exposeGodHealthTool: true,
    withCache: async (_query, _opts, loader) => loader(),
    runSearch: async () => searchResult(),
    extractPage: async url => ({ url, title: 'Page', text: 'Body' }),
  });
  const server = createMcpServer(deps);
  const client = new Client({ name: 'mcp-contract-test', version: '1.0.0' });
  const { clientTransport, serverTransport } = createTransportPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map(tool => tool.name).sort();
  assert(toolNames.join(',') === 'god_extract,god_health,god_search', 'lists expected tools');

  const result = await client.callTool({
    name: 'god_search',
    arguments: { query: 'sdk smoke', limit: 1 },
  });
  const payload = parseToolResult(result);
  assert(payload.query === 'sdk smoke', 'calls search through SDK transport');

  await client.close();
  await server.close();
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

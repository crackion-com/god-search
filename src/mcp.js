/**
 * mcp.js — MCP stdio server exposing god_search + god_extract tools
 * CRITICAL: stdout is owned by MCP stdio transport. ALL logging → console.error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';
import { z } from 'zod';
import { AGENT_CONFIG, APP } from './config.js';
import { withCache } from './cache.js';
import { cacheStats } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { browserStatus, closeBrowser } from './browser.js';
import { buildSearchResponse } from './response.js';
import {
  noteError,
  noteExtractComplete,
  noteExtractStart,
  noteHealthRequest,
  noteSearchComplete,
  noteSearchStart,
  runtimeSnapshot,
} from './runtime.js';

const { version } = createRequire(import.meta.url)('../package.json');
const ENGINE_ENUM = ['official', 'ddg', 'bing', 'brave', 'google', 'reddit', 'github', 'stackoverflow', 'hackernews', 'npm', 'wikipedia'];

function defaultDeps(deps = {}) {
  const runtime = deps.runtime || {};
  return {
    app: deps.app || APP,
    version: deps.version || version,
    exposeGodHealthTool: deps.exposeGodHealthTool ?? AGENT_CONFIG.exposeGodHealthTool,
    withCache: deps.withCache || withCache,
    cacheStats: deps.cacheStats || cacheStats,
    runSearch: deps.runSearch || runSearch,
    extractPage: deps.extractPage || extractPage,
    browserStatus: deps.browserStatus || browserStatus,
    closeBrowser: deps.closeBrowser || closeBrowser,
    buildSearchResponse: deps.buildSearchResponse || buildSearchResponse,
    noteError: deps.noteError || runtime.noteError || noteError,
    noteExtractComplete: deps.noteExtractComplete || runtime.noteExtractComplete || noteExtractComplete,
    noteExtractStart: deps.noteExtractStart || runtime.noteExtractStart || noteExtractStart,
    noteHealthRequest: deps.noteHealthRequest || runtime.noteHealthRequest || noteHealthRequest,
    noteSearchComplete: deps.noteSearchComplete || runtime.noteSearchComplete || noteSearchComplete,
    noteSearchStart: deps.noteSearchStart || runtime.noteSearchStart || noteSearchStart,
    runtimeSnapshot: deps.runtimeSnapshot || runtime.runtimeSnapshot || runtimeSnapshot,
    logger: deps.logger || console,
  };
}

function textResult(payload, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...extra,
  };
}

export async function handleGodSearch({ query, limit = 10, engines, verbose = false } = {}, deps = {}) {
  const d = defaultDeps(deps);
  try {
    const startedAt = Date.now();
    d.noteSearchStart(query);
    const cacheOpts = { limit, engines };
    const result = await d.withCache(query, cacheOpts, () =>
      d.runSearch(query, { limit, engines, _cacheOpts: cacheOpts })
    );
    d.noteSearchComplete({
      elapsedMs: Date.now() - startedAt,
      engineErrors: result.engineStats?.errors || {},
    });

    const output = d.buildSearchResponse({
      query,
      result,
      verbose,
      app: d.app,
      cache: d.cacheStats(),
    });

    return textResult(output);
  } catch (err) {
    d.noteError('mcp.god_search', err);
    d.logger?.error?.('[god_search] error:', err);
    return textResult({ query, results: [], error: err.message }, { isError: true });
  }
}

export async function handleGodExtract({ url } = {}, deps = {}) {
  const d = defaultDeps(deps);
  try {
    const startedAt = Date.now();
    d.noteExtractStart(url);
    const result = await d.extractPage(url);
    d.noteExtractComplete({ elapsedMs: Date.now() - startedAt });
    return textResult({ ...result, meta: { app: d.app } });
  } catch (err) {
    d.noteError('mcp.god_extract', err);
    d.logger?.error?.('[god_extract] error:', err);
    return textResult({ url, error: err.message }, { isError: true });
  }
}

export async function handleGodHealth(args = {}, deps = undefined) {
  const d = defaultDeps(deps ?? (args?.cacheStats || args?.browserStatus ? args : {}));
  try {
    d.noteHealthRequest();
    return textResult({
      status: 'ok',
      ready: true,
      app: d.app,
      browser: d.browserStatus(),
      cache: d.cacheStats(),
      runtime: d.runtimeSnapshot(),
    });
  } catch (err) {
    d.noteError('mcp.god_health', err);
    return textResult({ status: 'error', error: err.message }, { isError: true });
  }
}

export function createMcpServer(deps = {}, options = {}) {
  const d = defaultDeps(deps);
  const server = new McpServer({
    name: options.name || d.app.name,
    version: options.version || d.version,
  }, options.serverOptions);

  server.tool(
    'god_search',
    {
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(20).optional().default(10)
        .describe('Maximum results to return (1-20, default 10)'),
      engines: z.array(z.enum(ENGINE_ENUM))
        .optional()
        .describe('Specific engines to use (default: all 7)'),
      verbose: z.boolean().optional().default(false)
        .describe('Include engine stats, timing, and score breakdown'),
    },
    args => handleGodSearch(args, d)
  );

  server.tool(
    'god_extract',
    {
      url: z.string().url().describe('URL to extract full content from'),
    },
    args => handleGodExtract(args, d)
  );

  const exposeGodHealthTool = options.exposeGodHealthTool ?? d.exposeGodHealthTool;
  if (exposeGodHealthTool) {
    server.tool('god_health', {}, args => handleGodHealth(args, d));
  }

  return server;
}

export async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] god-search MCP server running on stdio');

  process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });
}

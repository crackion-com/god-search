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

const server = new McpServer({
  name: APP.name,
  version,
});

// ─── god_search ─────────────────────────────────────────────────────────────

server.tool(
  'god_search',
  {
    query: z.string().min(1).describe('Search query'),
    limit: z.number().int().min(1).max(20).optional().default(10)
      .describe('Maximum results to return (1–20, default 10)'),
    engines: z.array(z.enum(['ddg', 'bing', 'brave', 'google', 'reddit', 'github', 'wikipedia']))
      .optional()
      .describe('Specific engines to use (default: all 7)'),
    verbose: z.boolean().optional().default(false)
      .describe('Include engine stats, timing, and score breakdown'),
  },
  async ({ query, limit, engines, verbose }) => {
    try {
      const startedAt = Date.now();
      noteSearchStart(query);
      const cacheOpts = { limit, engines };
      const result = await withCache(query, cacheOpts, () =>
        runSearch(query, { limit, engines, _cacheOpts: cacheOpts })
      );
      noteSearchComplete({
        elapsedMs: Date.now() - startedAt,
        engineErrors: result.engineStats?.errors || {},
      });

      const output = {
        query,
        results: result.results,
        total: result.results.length,
        partial: !!result.partial,
      };

      if (verbose || result.fromCache) {
        if (result.fromCache) output.cached = true;
        if (verbose) {
          output.elapsed_ms = result.elapsed_ms;
          output.engines = result.engineStats;
        }
      }
      output.meta = {
        app: APP,
        cache: cacheStats(),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      noteError('mcp.god_search', err);
      console.error('[god_search] error:', err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, results: [], error: err.message }, null, 2),
        }],
        isError: true,
      };
    }
  }
);

// ─── god_extract ─────────────────────────────────────────────────────────────

server.tool(
  'god_extract',
  {
    url: z.string().url().describe('URL to extract full content from'),
  },
  async ({ url }) => {
    try {
      const startedAt = Date.now();
      noteExtractStart(url);
      const result = await extractPage(url);
      noteExtractComplete({ elapsedMs: Date.now() - startedAt });
      result.meta = { app: APP };
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      noteError('mcp.god_extract', err);
      console.error('[god_extract] error:', err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ url, error: err.message }, null, 2),
        }],
        isError: true,
      };
    }
  }
);

if (AGENT_CONFIG.exposeGodHealthTool) {
  server.tool(
    'god_health',
    {},
    async () => {
      try {
        noteHealthRequest();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              ready: true,
              app: APP,
              browser: browserStatus(),
              cache: cacheStats(),
              runtime: runtimeSnapshot(),
            }, null, 2),
          }],
        };
      } catch (err) {
        noteError('mcp.god_health', err);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', error: err.message }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );
}

// ─── startup ─────────────────────────────────────────────────────────────────

export async function startMcp() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] god-search MCP server running on stdio');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });
}

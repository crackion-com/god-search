/**
 * mcp.js — MCP stdio server exposing god_search + god_extract tools
 * CRITICAL: stdout is owned by MCP stdio transport. ALL logging → console.error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { withCache } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { closeBrowser } from './browser.js';

const server = new McpServer({
  name: 'god-search',
  version: '1.0.0',
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
      const cacheOpts = { limit, engines };
      const result = await withCache(query, cacheOpts, () =>
        runSearch(query, { limit, engines, _cacheOpts: cacheOpts })
      );

      const output = {
        query,
        results: result.results,
        total: result.results.length,
      };

      if (verbose || result.fromCache) {
        if (result.fromCache) output.cached = true;
        if (verbose) {
          output.elapsed_ms = result.elapsed_ms;
          output.engines = result.engineStats;
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
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
      const result = await extractPage(url);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
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

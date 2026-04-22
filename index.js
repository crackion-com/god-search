#!/usr/bin/env node
/**
 * index.js — god-search entry point
 *
 * Modes (argv[2]):
 *   mcp      → MCP stdio server (for AI agents: Claude, OpenCode, Cursor, etc.)
 *   serve    → HTTP daemon on localhost:3847
 *   <query>  → CLI search, print JSON to stdout
 *
 * Usage:
 *   god-search mcp                          # MCP server
 *   god-search serve                        # HTTP daemon
 *   god-search "anthropic claude api"       # CLI search
 *   god-search "rust async" --limit 5       # CLI with limit
 *   god-search "python requests" --verbose  # CLI with stats
 */

import { createRequire } from 'module';
import { withCache } from './src/cache.js';
import { APP, HTTP_CONFIG } from './src/config.js';
import { runSearch } from './src/merger.js';
import { closeBrowser } from './src/browser.js';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');
const [, , mode, ...rest] = process.argv;

if (mode === 'mcp') {
  const { startMcp } = await import('./src/mcp.js');
  await startMcp();

} else if (mode === 'serve') {
  const { startHttp } = await import('./src/http.js');
  await startHttp();

} else if (mode === 'extract') {
  const url = rest[0];
  if (!url || !url.startsWith('http')) {
    console.error('Usage: god-search extract <url>');
    process.exit(1);
  }
  try {
    const { extractPage } = await import('./src/extractor.js');
    const result = await extractPage(url);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    console.error('Extract failed:', err.message);
    process.exit(1);
  } finally {
    await closeBrowser();
    process.exit(0);
  }

} else if (mode && !mode.startsWith('-')) {
  // CLI mode: argv[2] is the query
  const args = [mode, ...rest];
  const limitIdx = args.indexOf('--limit');
  const skipSet = new Set();
  if (limitIdx !== -1 && limitIdx + 1 < args.length) skipSet.add(limitIdx + 1);
  const query = args.filter((a, i) => !a.startsWith('-') && !skipSet.has(i)).join(' ');
  const limitArg = args.find(a => a.startsWith('--limit=')) || args[args.indexOf('--limit') + 1];
  const limit = limitArg ? parseInt(String(limitArg).replace('--limit=', ''), 10) : 10;
  const verbose = args.includes('--verbose') || args.includes('-v');
  const fieldsArg = args.find(a => a.startsWith('--fields='));
  const fields = fieldsArg ? new Set(fieldsArg.replace('--fields=', '').split(',')) : null;

  if (!query) {
    console.error('Usage: god-search <query> [--limit N] [--verbose]');
    process.exit(1);
  }

  try {
    const cacheOpts = { limit };
    const result = await withCache(query, cacheOpts, () =>
      runSearch(query, { limit, _cacheOpts: cacheOpts })
    );

    const results = fields
      ? result.results.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => fields.has(k))))
      : result.results;

    const output = {
      query,
      results,
      total: results.length,
      partial: !!result.partial,
      meta: { app: APP },
    };

    if (verbose) {
      output.elapsed_ms = result.elapsed_ms;
      output.engines = result.engineStats;
    }

    // CLI: print to stdout
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    console.error('Search failed:', err.message);
    process.exit(1);
  } finally {
    await closeBrowser();
    process.exit(0);
  }

} else {
  console.error(`${APP.name} v${version} — Free unlimited universal web search

Usage:
  ${APP.name} mcp                          MCP stdio server
  ${APP.name} serve                        HTTP daemon on http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}
  ${APP.name} extract <url>                Extract full page text
  ${APP.name} "query"                      CLI search (compact JSON)
  ${APP.name} "query" --limit 5           Limit results
  ${APP.name} "query" --fields=title,url  Select specific fields

Engines: DDG, Bing, Google, Reddit, GitHub, Wikipedia (+ Brave opt-in: GOD_SEARCH_ENABLE_BRAVE=true)`);
  process.exit(0);
}

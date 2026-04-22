/**
 * http.js — HTTP daemon mode
 * Exposes god_search and god_extract over a simple JSON API.
 * All logging → console.error.
 */

import { createServer } from 'node:http';
import { APP, BROWSER_CONFIG, HTTP_CONFIG } from './config.js';
import { withCache } from './cache.js';
import { cacheStats } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { closeBrowser, browserStatus } from './browser.js';
import { buildOpenApiSpec } from './openapi.js';
import {
  noteError,
  noteExtractComplete,
  noteExtractStart,
  noteHealthRequest,
  noteSearchComplete,
  noteSearchStart,
  runtimeSnapshot,
} from './runtime.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

export async function startHttp() {
  if (BROWSER_CONFIG.prewarmOnStart) {
    try {
      await import('./browser.js').then(({ ensureBrowser }) => ensureBrowser());
    } catch (err) {
      noteError('http.prewarm', err);
      console.error('[http] browser prewarm failed:', err.message);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}`);

    try {
      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        noteHealthRequest();
        return json(res, 200, {
          status: 'ok',
          ready: true,
          app: APP,
          browser: browserStatus(),
          cache: cacheStats(),
          runtime: runtimeSnapshot(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        return json(res, 200, buildOpenApiSpec());
      }

      // POST /search
      if (req.method === 'POST' && url.pathname === '/search') {
        const body = await readBody(req);
        const { query, limit = 10, engines, verbose = false } = body;
        if (!query || typeof query !== 'string') {
          return json(res, 400, { error: 'query is required' });
        }
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
        const output = { query, results: result.results, total: result.results.length };
        if (verbose) { output.elapsed_ms = result.elapsed_ms; output.engines = result.engineStats; }
        if (result.fromCache) output.cached = true;
        output.partial = !!result.partial;
        output.meta = {
          app: APP,
          cache: cacheStats(),
        };
        return json(res, 200, output);
      }

      // POST /extract
      if (req.method === 'POST' && url.pathname === '/extract') {
        const body = await readBody(req);
        const { url: targetUrl } = body;
        if (!targetUrl || typeof targetUrl !== 'string') {
          return json(res, 400, { error: 'url is required' });
        }
        const startedAt = Date.now();
        noteExtractStart(targetUrl);
        const result = await extractPage(targetUrl);
        noteExtractComplete({ elapsedMs: Date.now() - startedAt });
        result.meta = { app: APP };
        return json(res, 200, result);
      }

      json(res, 404, { error: 'Not found', routes: ['GET /health', 'GET /openapi.json', 'POST /search', 'POST /extract'] });
    } catch (err) {
      noteError('http.request', err);
      console.error('[http] error:', err);
      const isExtract = req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/extract';
      const msg = isExtract ? `Extract failed: ${err.message.split('\n')[0]}` : err.message;
      json(res, 500, { error: msg });
    }
  });

  server.listen(HTTP_CONFIG.port, HTTP_CONFIG.host, () => {
    console.error(`[http] god-search HTTP daemon listening on http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}`);
  });

  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
}

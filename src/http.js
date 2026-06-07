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

export function createHttpServer(deps = {}) {
  const app = deps.app || APP;
  const httpConfig = deps.httpConfig || HTTP_CONFIG;
  const runSearchDep = deps.runSearch || runSearch;
  const extractDep = deps.extract || deps.extractPage || extractPage;
  const withCacheDep = deps.withCache || withCache;
  const cacheStatsDep = deps.cacheStats || cacheStats;
  const browserStatusDep = deps.browserStatus || browserStatus;
  const buildOpenApiSpecDep = deps.buildOpenApiSpec || buildOpenApiSpec;
  const buildSearchResponseDep = deps.buildSearchResponse || buildSearchResponse;
  const runtime = deps.runtime || {};
  const noteErrorDep = deps.noteError || runtime.noteError || noteError;
  const noteExtractCompleteDep = deps.noteExtractComplete || runtime.noteExtractComplete || noteExtractComplete;
  const noteExtractStartDep = deps.noteExtractStart || runtime.noteExtractStart || noteExtractStart;
  const noteHealthRequestDep = deps.noteHealthRequest || runtime.noteHealthRequest || noteHealthRequest;
  const noteSearchCompleteDep = deps.noteSearchComplete || runtime.noteSearchComplete || noteSearchComplete;
  const noteSearchStartDep = deps.noteSearchStart || runtime.noteSearchStart || noteSearchStart;
  const runtimeSnapshotDep = deps.runtimeSnapshot || runtime.runtimeSnapshot || runtimeSnapshot;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${httpConfig.host}:${httpConfig.port}`);

    try {
      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        noteHealthRequestDep();
        return json(res, 200, {
          status: 'ok',
          ready: true,
          app,
          browser: browserStatusDep(),
          cache: cacheStatsDep(),
          runtime: runtimeSnapshotDep(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        return json(res, 200, buildOpenApiSpecDep());
      }

      // POST /search
      if (req.method === 'POST' && url.pathname === '/search') {
        const body = await readBody(req);
        const { query, limit = 10, engines, verbose = false } = body;
        if (!query || typeof query !== 'string') {
          return json(res, 400, { error: 'query is required' });
        }
        const startedAt = Date.now();
        noteSearchStartDep(query);
        const cacheOpts = { limit, engines };
        const result = await withCacheDep(query, cacheOpts, () =>
          runSearchDep(query, { limit, engines, _cacheOpts: cacheOpts })
        );
        noteSearchCompleteDep({
          elapsedMs: Date.now() - startedAt,
          engineErrors: result.engineStats?.errors || {},
        });
        const output = buildSearchResponseDep({
          query,
          result,
          verbose,
          app,
          cache: cacheStatsDep(),
        });
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
        noteExtractStartDep(targetUrl);
        const result = await extractDep(targetUrl);
        noteExtractCompleteDep({ elapsedMs: Date.now() - startedAt });
        result.meta = { app };
        return json(res, 200, result);
      }

      json(res, 404, { error: 'Not found', routes: ['GET /health', 'GET /openapi.json', 'POST /search', 'POST /extract'] });
    } catch (err) {
      noteErrorDep('http.request', err);
      console.error('[http] error:', err);
      const isExtract = req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/extract';
      const msg = isExtract ? `Extract failed: ${err.message.split('\n')[0]}` : err.message;
      json(res, 500, { error: msg });
    }
  });

  return server;
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

  const server = createHttpServer();

  server.listen(HTTP_CONFIG.port, HTTP_CONFIG.host, () => {
    console.error(`[http] god-search HTTP daemon listening on http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}`);
  });

  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
}

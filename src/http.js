/**
 * http.js — HTTP daemon mode on localhost:3847
 * Exposes god_search and god_extract over a simple JSON API.
 * All logging → console.error.
 */

import { createServer } from 'node:http';
import { withCache } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { closeBrowser, browserStatus } from './browser.js';

const PORT = 3847;
const HOST = '127.0.0.1'; // localhost only — not exposed externally

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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    try {
      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', browser: browserStatus() });
      }

      // POST /search
      if (req.method === 'POST' && url.pathname === '/search') {
        const body = await readBody(req);
        const { query, limit = 10, engines, verbose = false } = body;
        if (!query || typeof query !== 'string') {
          return json(res, 400, { error: 'query is required' });
        }
        const cacheOpts = { limit, engines };
        const result = await withCache(query, cacheOpts, () =>
          runSearch(query, { limit, engines, _cacheOpts: cacheOpts })
        );
        const output = { query, results: result.results, total: result.results.length };
        if (verbose) { output.elapsed_ms = result.elapsed_ms; output.engines = result.engineStats; }
        if (result.fromCache) output.cached = true;
        return json(res, 200, output);
      }

      // POST /extract
      if (req.method === 'POST' && url.pathname === '/extract') {
        const body = await readBody(req);
        const { url: targetUrl } = body;
        if (!targetUrl || typeof targetUrl !== 'string') {
          return json(res, 400, { error: 'url is required' });
        }
        const result = await extractPage(targetUrl);
        return json(res, 200, result);
      }

      json(res, 404, { error: 'Not found', routes: ['GET /health', 'POST /search', 'POST /extract'] });
    } catch (err) {
      console.error('[http] error:', err);
      const isExtract = req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/extract';
      const msg = isExtract ? `Extract failed: ${err.message.split('\n')[0]}` : err.message;
      json(res, 500, { error: msg });
    }
  });

  server.listen(PORT, HOST, () => {
    console.error(`[http] god-search HTTP daemon listening on http://${HOST}:${PORT}`);
  });

  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
}

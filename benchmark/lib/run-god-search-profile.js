#!/usr/bin/env node

import { closeBrowser } from '../../src/browser.js';
import { runSearch } from '../../src/merger.js';
import { readJsonl } from './metrics.js';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

const queriesFile = argValue('--queries');
const defaultLimit = Number(argValue('--limit', '20'));
const mode = argValue('--mode', 'settled');

if (!queriesFile) {
  console.error('Usage: node benchmark/lib/run-god-search-profile.js --queries benchmark/fixtures/queries.jsonl [--mode fast|settled]');
  process.exit(2);
}

if (!['fast', 'settled'].includes(mode)) {
  console.error(`Invalid --mode "${mode}". Expected "fast" or "settled".`);
  process.exit(2);
}

const runs = [];

try {
  const queries = await readJsonl(queriesFile);

  for (const query of queries) {
    const limit = Number(query.limit || defaultLimit);
    const started = Date.now();
    try {
      const searchOptions = {
        limit,
        intent: query.intent,
      };
      if (mode === 'settled') searchOptions.awaitBackground = true;
      if (mode === 'fast') searchOptions.includeBackgroundPromise = true;

      const result = await runSearch(query.query, searchOptions);
      runs.push({
        qid: query.qid,
        query: query.query,
        results: result.results || [],
        latency_ms: result.elapsed_ms ?? (Date.now() - started),
        profile_mode: mode,
        partial: !!result.partial,
        engineStats: result.engineStats,
        intent: result.intent || query.intent,
      });
      if (mode === 'fast') await result.background;
    } catch (err) {
      runs.push({
        qid: query.qid,
        query: query.query,
        results: [],
        latency_ms: Date.now() - started,
        profile_mode: mode,
        error: err?.message || String(err),
      });
    }
  }
} finally {
  await closeBrowser().catch(() => {});
}

process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);

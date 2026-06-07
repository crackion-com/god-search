#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEngineResults } from '../src/merger.js';
import {
  buildBlindJudgingPool,
  buildJudgmentPriorityQueue,
  serializeJsonl,
  validateBlindJudgingPool,
  validateJudgmentPriorityQueue,
} from './lib/blind-judging.js';
import {
  aggregateRepeatedEvaluations,
  evaluateSystem,
  formatNumber,
  qrelsAreShallow,
  readJson,
  readJsonl,
  readQrels,
  summarizeJudgmentDepth,
} from './lib/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const defaultQueriesFile = path.join(__dirname, 'fixtures', 'queries.jsonl');
const defaultQrelsFile = path.join(__dirname, 'fixtures', 'qrels.tsv');
const defaultEngineRunsFile = path.join(__dirname, 'fixtures', 'engine-runs.json');
const godSearchRunner = path.join(__dirname, 'lib', 'run-god-search-profile.js');

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

const runNoKey = hasFlag('--no-key');
const runLive = hasFlag('--live') || runNoKey;
const runOffline = hasFlag('--offline') || !runLive;
const defaultOutDir = path.join(
  __dirname,
  'runs',
  runLive && runOffline ? 'latest-all' : runNoKey ? 'latest-no-key' : runLive ? 'latest-live' : 'latest-offline',
);
const queriesFile = path.resolve(rootDir, argValue('--queries', defaultQueriesFile));
const qrelsFile = path.resolve(rootDir, argValue('--qrels', defaultQrelsFile));
const engineRunsFile = path.resolve(rootDir, argValue('--engine-runs', defaultEngineRunsFile));
const outDir = path.resolve(rootDir, argValue('--out', defaultOutDir));
const externalRequestDelayMs = nonNegativeIntegerEnv('BENCHMARK_EXTERNAL_DELAY_MS', 250);
const externalRequestRetries = nonNegativeIntegerEnv('BENCHMARK_EXTERNAL_RETRIES', 2);
const repeatCount = positiveIntegerArg('--repeats', 'BENCHMARK_REPEATS', 1);

const queries = await readJsonl(queriesFile);
const qrels = await readQrels(qrelsFile);
const evaluations = [];
const rawRuns = {};
const repeatRuns = {};
const repeatSummary = {};
const skipped = [];

if (runOffline) {
  const repeated = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const runs = await runOfflineMerged(queries, engineRunsFile);
    recordRawRuns('god-search-fixture', runs, repeat);
    repeated.push(evaluateSystem({ system: 'god-search-fixture', queries, qrels, runs }));
  }
  evaluations.push(withProfileMode(
    aggregateRepeatedEvaluations(repeated),
    'offline',
  ));
}

if (runLive) {
  const defaultEnv = withoutCredentialEnv(process.env);
  defaultEnv.GOD_SEARCH_ENABLE_BRAVE = 'false';
  await runGodSearchProfiles('god-search-default', queries, defaultEnv);

  if (!runNoKey) {
    if (hasGodSearchKeyedEnv(process.env)) {
      const keyedEnv = { ...process.env, GOD_SEARCH_ENABLE_BRAVE: 'true', GOD_SEARCH_BRAVE_MODE: process.env.GOD_SEARCH_BRAVE_MODE || 'auto' };
      await runGodSearchProfiles('god-search-keyed', queries, keyedEnv);
    } else {
      skipped.push('god-search-keyed: set BRAVE_SEARCH_API_KEY, GITHUB_TOKEN, or REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET');
    }

    await maybeRunExternalBaselines();
  }
}

const blindJudgingPool = buildBlindJudgingPool({ queries, rawRuns });
const blindJudgingPoolFile = path.join(outDir, 'blind-judging-pool.jsonl');
const judgmentPriorityQueue = buildJudgmentPriorityQueue({ queries, rawRuns, qrels });
const judgmentPriorityQueueFile = path.join(outDir, 'judgment-priority-queue.jsonl');
const blindPoolValidation = validateBlindJudgingPool(blindJudgingPool);
const judgmentPriorityValidation = validateJudgmentPriorityQueue(judgmentPriorityQueue);
const showJudgmentCoverage = qrelsAreShallow(queries, qrels);
const judgmentDepth = summarizeJudgmentDepth(queries, qrels);
const report = renderReport({
  evaluations,
  skipped,
  queriesFile,
  qrelsFile,
  runOffline,
  runLive,
  runNoKey,
  showJudgmentCoverage,
  judgmentDepth,
  blindJudgingPool,
  blindJudgingPoolFile,
  blindPoolValidation,
  judgmentPriorityQueue,
  judgmentPriorityQueueFile,
  judgmentPriorityValidation,
});
const result = {
  generated_at: new Date().toISOString(),
  queries_file: path.relative(rootDir, queriesFile),
  qrels_file: path.relative(rootDir, qrelsFile),
  offline: runOffline,
  live: runLive,
  no_key: runNoKey,
  repeats: repeatCount,
  skipped,
  blind_judging_pool: {
    file: path.relative(rootDir, blindJudgingPoolFile),
    depth: 20,
    url_count: blindJudgingPool.length,
    validation: blindPoolValidation,
  },
  judgment_priority_queue: {
    file: path.relative(rootDir, judgmentPriorityQueueFile),
    url_count: judgmentPriorityQueue.length,
    validation: judgmentPriorityValidation,
  },
  interpretation: interpretationMetadata({ runOffline, runLive, judgmentDepth }),
  summary: evaluations.map(({ system, profileMode, aggregate, byIntent, repeats, repeatAggregates }) => ({ system, profile_mode: profileMode, repeats, aggregate, byIntent, repeat_aggregates: repeatAggregates })),
  per_query: Object.fromEntries(evaluations.map(({ system, perQuery }) => [system, perQuery])),
  raw_runs: rawRuns,
  repeat_runs: repeatRuns,
  repeat_summary: repeatSummary,
};

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(path.join(outDir, 'report.md'), report);
await writeFile(blindJudgingPoolFile, serializeJsonl(blindJudgingPool));
await writeFile(judgmentPriorityQueueFile, serializeJsonl(judgmentPriorityQueue));

process.stdout.write(report);
process.stdout.write(`\nWrote ${path.relative(rootDir, path.join(outDir, 'report.md'))}\n`);

async function runOfflineMerged(queryRows, fixtureFile) {
  const engineRuns = await readJson(fixtureFile);

  return queryRows.map(query => {
    const engineMap = new Map(Object.entries(engineRuns[query.qid] || {}));
    return {
      qid: query.qid,
      query: query.query,
      results: mergeEngineResults(engineMap, query.query, query.limit || 20, query.intent),
      latency_ms: 0,
      profile_mode: 'offline',
      intent: query.intent,
    };
  });
}

async function runGodSearchProfiles(system, queryRows, env) {
  for (const mode of ['fast', 'settled']) {
    const profiledSystem = `${system}-${mode}`;
    const repeated = [];
    for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
      const runs = await runGodSearchProfile(profiledSystem, queryRows, env, mode);
      recordRawRuns(profiledSystem, runs, repeat);
      repeated.push(evaluateSystem({ system: profiledSystem, queries, qrels, runs }));
    }
    evaluations.push(withProfileMode(
      aggregateRepeatedEvaluations(repeated),
      mode,
    ));
  }
}

async function maybeRunExternalBaselines() {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    await runExternalBaseline('brave-api', searchBraveApi);
  } else {
    skipped.push('brave-api: set BRAVE_SEARCH_API_KEY');
  }

  if (process.env.TAVILY_API_KEY) {
    await runExternalBaseline('tavily', searchTavily);
  } else {
    skipped.push('tavily: set TAVILY_API_KEY');
  }

  if (process.env.EXA_API_KEY) {
    await runExternalBaseline('exa', searchExa);
  } else {
    skipped.push('exa: set EXA_API_KEY');
  }

  if (process.env.FIRECRAWL_API_KEY) {
    await runExternalBaseline('firecrawl', searchFirecrawl);
  } else {
    skipped.push('firecrawl: set FIRECRAWL_API_KEY');
  }

  if (process.env.SERPER_API_KEY) {
    await runExternalBaseline('serper', searchSerper);
  } else {
    skipped.push('serper: set SERPER_API_KEY');
  }
}

async function runExternalBaseline(system, searchFn) {
  const repeated = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const runs = await runExternalSystem(system, queries, searchFn);
    recordRawRuns(system, runs, repeat);
    repeated.push(evaluateSystem({ system, queries, qrels, runs }));
  }
  evaluations.push(withProfileMode(aggregateRepeatedEvaluations(repeated), 'single-call'));
}

function withoutCredentialEnv(source) {
  const env = { ...source };
  for (const key of [
    'BRAVE_SEARCH_API_KEY',
    'GITHUB_TOKEN',
    'REDDIT_CLIENT_ID',
    'REDDIT_CLIENT_SECRET',
    'TAVILY_API_KEY',
    'EXA_API_KEY',
    'FIRECRAWL_API_KEY',
    'SERPER_API_KEY',
  ]) {
    delete env[key];
  }
  return env;
}

function hasGodSearchKeyedEnv(env) {
  return !!(
    env.BRAVE_SEARCH_API_KEY ||
    env.GITHUB_TOKEN ||
    (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)
  );
}

function nonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveIntegerArg(argName, envName, fallback) {
  const raw = argValue(argName, process.env[envName] || String(fallback));
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function recordRawRuns(system, runs, repeat) {
  rawRuns[system] = runs;
  if (!repeatRuns[system]) repeatRuns[system] = [];
  repeatRuns[system].push({ repeat, runs });
  repeatSummary[system] = {
    repeats: repeatRuns[system].length,
    latest_repeat: repeat,
  };
}

async function runGodSearchProfile(system, queryRows, env, mode) {
  try {
    const stdout = await spawnCollect(process.execPath, [
      godSearchRunner,
      '--queries',
      queriesFile,
      '--mode',
      mode,
    ], env);
    return JSON.parse(stdout);
  } catch (err) {
    return queryRows.map(query => ({
      qid: query.qid,
      query: query.query,
      results: [],
      latency_ms: null,
      profile_mode: mode,
      error: `${system} (${mode}): ${err?.message || err}`,
    }));
  }
}

function withProfileMode(evaluation, profileMode) {
  return { ...evaluation, profileMode };
}

function interpretationMetadata({ runOffline: offline, runLive: live, judgmentDepth }) {
  return {
    scope: offline && !live
      ? 'offline fixture regression check'
      : 'run-specific benchmark comparison',
    qrels: {
      shallow: judgmentDepth.shallow_queries > 0,
      coverage_at_depth: judgmentDepth.coverage_at_depth,
      shallow_queries: judgmentDepth.shallow_queries,
      note: 'Unjudged URLs are scored as 0 in displayed metrics; review Judged@20/Unjudged@20 before making quality claims.',
    },
    profiles: {
      fast: 'user-visible first response, possibly partial',
      settled: 'full response after background engines settle',
      single_call: 'one external provider call; latency is provider response time',
      offline: 'fixture merge only; latency is not measured',
    },
  };
}

function spawnCollect(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    });
  });
}

async function runExternalSystem(system, queryRows, searchFn) {
  const runs = [];
  for (const [index, query] of queryRows.entries()) {
    if (index > 0 && externalRequestDelayMs > 0) await sleep(externalRequestDelayMs);
    const started = Date.now();
    try {
      runs.push({
        qid: query.qid,
        query: query.query,
        results: await searchFn(query.query, query.limit || 20),
        latency_ms: Date.now() - started,
        profile_mode: 'single-call',
      });
    } catch (err) {
      runs.push({
        qid: query.qid,
        query: query.query,
        results: [],
        latency_ms: Date.now() - started,
        profile_mode: 'single-call',
        error: `${system}: ${err?.message || err}`,
      });
    }
  }
  return runs;
}

async function searchBraveApi(query, limit) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));
  const data = await fetchJson(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
  });
  return (data.web?.results || []).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
  })).filter(validResult).slice(0, limit);
}

async function searchTavily(query, limit) {
  const data = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: Math.min(limit, 20),
    }),
  });
  return (data.results || []).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || item.snippet || '',
  })).filter(validResult).slice(0, limit);
}

async function searchExa(query, limit) {
  const data = await fetchJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      numResults: Math.min(limit, 20),
      type: 'auto',
      contents: {
        highlights: true,
      },
    }),
  });
  return (data.results || []).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.highlights?.[0] || item.text || item.summary || '',
  })).filter(validResult).slice(0, limit);
}

async function searchFirecrawl(query, limit) {
  const data = await fetchJson('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      limit: Math.min(limit, 20),
      sources: ['web'],
    }),
  });
  const results = Array.isArray(data.data?.web)
    ? data.data.web
    : Array.isArray(data.data)
      ? data.data
      : data.results || [];
  return results.map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || item.markdown || item.content || '',
  })).filter(validResult).slice(0, limit);
}

async function searchSerper(query, limit) {
  const data = await fetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, num: Math.min(limit, 20) }),
  });
  return (data.organic || []).map(item => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
  })).filter(validResult).slice(0, limit);
}

async function fetchJson(url, options = {}) {
  for (let attempt = 0; attempt <= externalRequestRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < externalRequestRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
    clearTimeout(timer);

    if (!response.ok) {
      if (attempt < externalRequestRetries && retryableStatus(response.status)) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }

    return await response.json();
  }
}

function validResult(item) {
  return item.title && /^https?:\/\//i.test(item.url);
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return backoffMs(attempt);
}

function backoffMs(attempt) {
  return Math.min(8000, 750 * 2 ** attempt);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderReport({
  evaluations: evals,
  skipped: skippedSystems,
  queriesFile: qFile,
  qrelsFile: relsFile,
  runOffline: offline,
  runLive: live,
  runNoKey: noKey,
  showJudgmentCoverage,
  judgmentDepth,
  blindJudgingPool: pool,
  blindJudgingPoolFile: poolFile,
  blindPoolValidation,
  judgmentPriorityQueue: priorityQueue,
  judgmentPriorityQueueFile: priorityFile,
  judgmentPriorityValidation,
}) {
  const lines = [
    '# god-search benchmark report',
    '',
    `Mode: ${offline ? 'offline' : ''}${offline && live ? ' + ' : ''}${noKey ? 'no-key live' : live ? 'live' : ''}`,
    `Repeats: ${repeatCount}`,
    `Queries: ${path.relative(rootDir, qFile)}`,
    `Qrels: ${path.relative(rootDir, relsFile)}`,
    `Blind judging pool: ${path.relative(rootDir, poolFile)} (${pool.length} deduped URLs)`,
    `Blind pool validation: ${blindPoolValidation.ok ? 'ok' : `${blindPoolValidation.errors.length} errors`}`,
    `Judgment priority queue: ${path.relative(rootDir, priorityFile)} (${priorityQueue.length} unjudged URLs)`,
    `Judgment queue validation: ${judgmentPriorityValidation.ok ? 'ok' : `${judgmentPriorityValidation.errors.length} errors`}`,
    '',
    '## Interpretation Guardrails',
    '',
    '- Offline mode is a deterministic regression check against fixtures, not a public leaderboard claim.',
    '- Live rows are run-specific snapshots. Compare systems only within the same run and compatible profile modes.',
    `- Fast/user-visible latency measures the first response; settled/full latency measures await-background completion. The columns are intentionally separate.`,
    `- Qrels depth coverage is ${formatNumber(judgmentDepth.coverage_at_depth)} at depth ${judgmentDepth.depth}; ${judgmentDepth.shallow_queries} of ${judgmentDepth.queries} queries are shallow.`,
    '- Unjudged URLs are scored as 0 in displayed metrics, so use Judged@20/Unjudged@20 and the blind pool before making quality claims.',
    '',
    '## Summary',
    '',
    showJudgmentCoverage
      ? '| System | Profile | Repeats | Overall | Valid | nDCG@10 | Strict nDCG@10 | MRR@10 | P@5 | Recall@20 | Judged@20 | Unjudged@20 | User-visible avg ms | User-visible p95 ms | Settled/full avg ms | Settled/full p95 ms | Errors |'
      : '| System | Profile | Repeats | Overall | Valid | nDCG@10 | Strict nDCG@10 | MRR@10 | P@5 | Recall@20 | User-visible avg ms | User-visible p95 ms | Settled/full avg ms | Settled/full p95 ms | Errors |',
    showJudgmentCoverage
      ? '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
      : '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];

  for (const evaluation of evals) {
    const row = evaluation.aggregate;
    const fastLatency = latencyForReport(evaluation, 'fast');
    const settledLatency = latencyForReport(evaluation, 'settled');
    if (showJudgmentCoverage) {
      lines.push(`| ${evaluation.system} | ${profileLabel(evaluation.profileMode)} | ${evaluation.repeats || 1} | ${formatNumber(row.overall_score, 1)} | ${formatNumber(row.valid_response)} | ${formatNumber(row.ndcg10)} | ${formatNumber(row.strict_ndcg10)} | ${formatNumber(row.mrr10)} | ${formatNumber(row.p5)} | ${formatNumber(row.recall20)} | ${formatNumber(row.judged_coverage20)} | ${formatNumber(row.unjudged_rate20)} | ${formatNumber(fastLatency.avg, 1)} | ${formatNumber(fastLatency.p95, 1)} | ${formatNumber(settledLatency.avg, 1)} | ${formatNumber(settledLatency.p95, 1)} | ${row.error_count} |`);
    } else {
      lines.push(`| ${evaluation.system} | ${profileLabel(evaluation.profileMode)} | ${evaluation.repeats || 1} | ${formatNumber(row.overall_score, 1)} | ${formatNumber(row.valid_response)} | ${formatNumber(row.ndcg10)} | ${formatNumber(row.strict_ndcg10)} | ${formatNumber(row.mrr10)} | ${formatNumber(row.p5)} | ${formatNumber(row.recall20)} | ${formatNumber(fastLatency.avg, 1)} | ${formatNumber(fastLatency.p95, 1)} | ${formatNumber(settledLatency.avg, 1)} | ${formatNumber(settledLatency.p95, 1)} | ${row.error_count} |`);
    }
  }

  lines.push('', '## By Intent', '');
  for (const evaluation of evals) {
    lines.push(`### ${evaluation.system}`, '');
    lines.push(showJudgmentCoverage
      ? '| Intent | Queries | Overall | Valid | nDCG@10 | MRR@10 | P@5 | Recall@20 | Judged@20 | Unjudged@20 |'
      : '| Intent | Queries | Overall | Valid | nDCG@10 | MRR@10 | P@5 | Recall@20 |');
    lines.push(showJudgmentCoverage
      ? '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
      : '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [intent, row] of Object.entries(evaluation.byIntent)) {
      if (showJudgmentCoverage) {
        lines.push(`| ${intent} | ${row.queries} | ${formatNumber(row.overall_score, 1)} | ${formatNumber(row.valid_response)} | ${formatNumber(row.ndcg10)} | ${formatNumber(row.mrr10)} | ${formatNumber(row.p5)} | ${formatNumber(row.recall20)} | ${formatNumber(row.judged_coverage20)} | ${formatNumber(row.unjudged_rate20)} |`);
      } else {
        lines.push(`| ${intent} | ${row.queries} | ${formatNumber(row.overall_score, 1)} | ${formatNumber(row.valid_response)} | ${formatNumber(row.ndcg10)} | ${formatNumber(row.mrr10)} | ${formatNumber(row.p5)} | ${formatNumber(row.recall20)} |`);
      }
    }
    lines.push('');
  }

  const worstRows = worstQueries(evals);
  if (worstRows.length) {
    lines.push('## Worst Queries', '');
    lines.push('| System | QID | Intent | nDCG@10 | MRR@10 | Judged@20 | Unjudged@20 | Results | Error |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---|');
    for (const row of worstRows) {
      lines.push(`| ${row.system} | ${row.qid} | ${row.intent || ''} | ${formatNumber(row.ndcg10)} | ${formatNumber(row.mrr10)} | ${formatNumber(row.judged_coverage20)} | ${formatNumber(row.unjudged_rate20)} | ${row.result_count} | ${escapeTableCell(row.error || '')} |`);
    }
    lines.push('');
  }

  if (skippedSystems.length) {
    lines.push('## Skipped', '');
    for (const item of skippedSystems) lines.push(`- ${item}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function worstQueries(evaluations, limit = 10) {
  return evaluations
    .flatMap(evaluation => evaluation.perQuery.map(row => ({
      ...row,
      system: evaluation.system,
    })))
    .sort((a, b) =>
      Number(Boolean(b.error)) - Number(Boolean(a.error)) ||
      a.ndcg10 - b.ndcg10 ||
      a.mrr10 - b.mrr10 ||
      b.unjudged_rate20 - a.unjudged_rate20 ||
      a.result_count - b.result_count ||
      a.qid.localeCompare(b.qid)
    )
    .slice(0, limit);
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function latencyForReport(evaluation, target) {
  const mode = evaluation.profileMode;
  const row = evaluation.aggregate;
  if (mode === 'offline') return { avg: null, p95: null };
  if (mode === 'single-call' || mode === target) {
    return { avg: row.latency_ms_avg, p95: row.latency_ms_p95 };
  }
  return { avg: null, p95: null };
}

function profileLabel(mode) {
  if (mode === 'fast') return 'fast/user-visible';
  if (mode === 'settled') return 'settled/full';
  if (mode === 'single-call') return 'single-call';
  if (mode === 'offline') return 'offline fixture';
  return mode || 'unknown';
}

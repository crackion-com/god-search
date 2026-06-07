#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeUrlForJudging,
  formatNumber,
  readJson,
  readJsonl,
  readQrels,
} from '../lib/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

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

function argValues(name) {
  const prefix = `${name}=`;
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    if (arg === name && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  }
  return values.flatMap(value => value.split(',').map(item => item.trim()).filter(Boolean));
}

if (hasFlag('--help')) {
  process.stdout.write([
    'Usage: node benchmark/scripts/analyze-misses.js [--results benchmark/runs/latest-live/results.json] [--system name] [--depth 20] [--out report.md]',
    '',
    'Reports judged relevant qrels missing from each run and unjudged top results that need pooled judging.',
    'By default it uses the queries and qrels paths recorded in results.json.',
    '',
  ].join('\n'));
  process.exit(0);
}

const resultsFile = path.resolve(rootDir, argValue('--results', 'benchmark/runs/latest-live/results.json'));
const result = await readJson(resultsFile);
const queriesFile = path.resolve(rootDir, argValue('--queries', result.queries_file || 'benchmark/fixtures/queries.jsonl'));
const qrelsFile = path.resolve(rootDir, argValue('--qrels', result.qrels_file || 'benchmark/fixtures/qrels.tsv'));
const outputFile = argValue('--out');
const depth = positiveInteger(argValue('--depth'), 20);
const requestedSystems = new Set(argValues('--system'));
const queries = await readJsonl(queriesFile);
const qrels = await readQrels(qrelsFile);

if (!result.raw_runs || typeof result.raw_runs !== 'object') {
  throw new Error(`${resultsFile} does not contain raw_runs`);
}

const systems = Object.keys(result.raw_runs)
  .filter(system => requestedSystems.size === 0 || requestedSystems.has(system));

if (systems.length === 0) {
  throw new Error(`No matching systems in ${resultsFile}`);
}

const analyses = systems.map(system => analyzeSystem(system, result.raw_runs[system] || []));
const report = renderReport(analyses);

if (outputFile) {
  await writeFile(path.resolve(rootDir, outputFile), report);
} else {
  process.stdout.write(report);
}

function analyzeSystem(system, runs) {
  const runsByQid = new Map(runs.map(run => [run.qid, run]));
  const queryRows = queries.map(query => analyzeQuery(system, query, runsByQid.get(query.qid)));
  const totals = queryRows.reduce((acc, row) => {
    acc.queries += 1;
    acc.relevant += row.relevant.length;
    acc.missed += row.missed.length;
    acc.top_results += row.topResults.length;
    acc.judged_top_results += row.judgedTopResults;
    acc.unjudged += row.unjudged.length;
    if (row.error) acc.errors += 1;
    return acc;
  }, {
    queries: 0,
    relevant: 0,
    missed: 0,
    top_results: 0,
    judged_top_results: 0,
    unjudged: 0,
    errors: 0,
  });

  return {
    system,
    totals: {
      ...totals,
      judged_coverage: totals.top_results ? totals.judged_top_results / totals.top_results : 0,
      judged_recall: totals.relevant ? (totals.relevant - totals.missed) / totals.relevant : 0,
    },
    queries: queryRows.sort((a, b) =>
      b.missed.length - a.missed.length ||
      b.unjudged.length - a.unjudged.length ||
      a.qid.localeCompare(b.qid)
    ),
  };
}

function analyzeQuery(system, query, run) {
  const judgments = qrels.get(query.qid) || new Map();
  const relevant = [...judgments.entries()]
    .filter(([, relevance]) => relevance >= 2)
    .map(([url, relevance]) => ({ url, relevance }))
    .sort((a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url));

  const topResults = Array.isArray(run?.results) ? run.results.slice(0, depth) : [];
  const seen = new Set(topResults.map(result => canonicalizeUrlForJudging(result.url)));
  const missed = relevant.filter(row => !seen.has(row.url));
  const unjudged = topResults
    .map((result, index) => ({
      rank: index + 1,
      title: result.title || '',
      url: result.url || '',
      canonical_url: canonicalizeUrlForJudging(result.url),
    }))
    .filter(result => !judgments.has(result.canonical_url));

  return {
    system,
    qid: query.qid,
    query: query.query,
    intent: query.intent || '',
    error: run?.error || null,
    relevant,
    missed,
    topResults,
    judgedTopResults: topResults.length - unjudged.length,
    unjudged,
  };
}

function renderReport(analyses) {
  const lines = [
    '# Benchmark Miss Analysis',
    '',
    `Results: ${path.relative(rootDir, resultsFile)}`,
    `Queries: ${path.relative(rootDir, queriesFile)}`,
    `Qrels: ${path.relative(rootDir, qrelsFile)}`,
    `Depth: ${depth}`,
    '',
  ];

  for (const analysis of analyses) {
    const totals = analysis.totals;
    lines.push(
      `## ${analysis.system}`,
      '',
      `Judged relevant recall@${depth}: ${totals.relevant - totals.missed}/${totals.relevant} (${formatNumber(totals.judged_recall)})`,
      `Top-${depth} judged coverage: ${totals.judged_top_results}/${totals.top_results} (${formatNumber(totals.judged_coverage)})`,
      `Unjudged top results: ${totals.unjudged}`,
      `Errors: ${totals.errors}`,
      '',
      '| QID | Intent | Missed relevant | Unjudged top results | Error | Query |',
      '|---|---|---:|---:|---|---|',
    );

    for (const row of analysis.queries) {
      if (!row.missed.length && !row.unjudged.length && !row.error) continue;
      lines.push(`| ${escapeCell(row.qid)} | ${escapeCell(row.intent)} | ${row.missed.length} | ${row.unjudged.length} | ${escapeCell(row.error || '')} | ${escapeCell(row.query)} |`);
    }

    for (const row of analysis.queries) {
      if (!row.missed.length && !row.unjudged.length && !row.error) continue;
      lines.push('', `### ${row.qid}: ${row.query}`, '');
      if (row.error) lines.push(`Error: ${row.error}`, '');
      if (row.missed.length) {
        lines.push(`Missed judged relevant URLs:`);
        for (const item of row.missed) lines.push(`- rel ${item.relevance}: ${item.url}`);
      }
      if (row.unjudged.length) {
        lines.push('', `Unjudged top-${depth} results:`);
        for (const item of row.unjudged) {
          lines.push(`- #${item.rank}: ${item.title ? `${item.title} - ` : ''}${item.url}`);
        }
      }
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { poolRowsToQrels, validateBlindJudgingPool } from '../lib/blind-judging.js';
import { canonicalizeUrlForJudging } from '../lib/metrics.js';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

const inputFile = argValue('--input', 'benchmark/runs/latest/blind-judging-pool.jsonl');
const outputFile = argValue('--out');
const baseFile = argValue('--base');
const allowPartial = process.argv.includes('--allow-partial');

if (process.argv.includes('--help')) {
  process.stdout.write([
    'Usage: node benchmark/scripts/pool-to-qrels.js --input judged-pool.jsonl [--base qrels.tsv] [--out qrels.tsv] [--allow-partial]',
    '',
    'Rows must come from the blind judging pool and include relevance grades 0, 1, 2, or 3.',
    'By default every pooled row must be judged; --allow-partial emits only judged rows.',
    '--base merges judged pool rows into an existing qrels file; pool judgments override matching base rows.',
    '',
  ].join('\n'));
  process.exit(0);
}

const text = await readFile(inputFile, 'utf8');
const rows = text
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

const validation = validateBlindJudgingPool(rows, { requireJudgments: !allowPartial });
if (!validation.ok) {
  for (const error of validation.errors.slice(0, 20)) {
    console.error(error);
  }
  if (validation.errors.length > 20) console.error(`...and ${validation.errors.length - 20} more`);
  process.exit(1);
}

const pooledQrels = poolRowsToQrels(rows, { requireJudgments: !allowPartial });
const qrels = baseFile
  ? mergeQrels(await readFile(baseFile, 'utf8'), pooledQrels)
  : pooledQrels;
if (outputFile) {
  await writeFile(outputFile, qrels);
} else {
  process.stdout.write(qrels);
}

const coverage = validation.rows ? validation.judged_count / validation.rows : 1;
console.error(`converted ${validation.judged_count} judged rows from ${inputFile}`);
console.error(`coverage ${validation.judged_count}/${validation.rows} judged (${(coverage * 100).toFixed(1)}%); ${validation.unjudged_count} unjudged`);
if (baseFile) console.error(`merged with base qrels from ${baseFile}`);

function mergeQrels(baseText, poolText) {
  const merged = new Map();
  for (const row of parseQrels(baseText, 'base')) {
    merged.set(row.key, row);
  }
  for (const row of parseQrels(poolText, 'pool')) {
    merged.set(row.key, row);
  }

  return [...merged.values()]
    .sort((a, b) => a.qid.localeCompare(b.qid) || a.url.localeCompare(b.url))
    .map(row => `${row.qid}\t0\t${row.url}\t${row.relevance}`)
    .join('\n') + (merged.size ? '\n' : '');
}

function parseQrels(text, label) {
  return text
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line, index) => {
      const [qid, , url, relevance] = line.split(/\s+/);
      if (!qid || !url || relevance == null) {
        throw new Error(`${label} qrels line ${index + 1}: expected "qid 0 url relevance"`);
      }
      const grade = Number(relevance);
      if (!Number.isFinite(grade)) {
        throw new Error(`${label} qrels line ${index + 1}: relevance must be numeric`);
      }
      return {
        key: `${qid}\t${canonicalizeUrlForJudging(url)}`,
        qid,
        url: canonicalizeUrlForJudging(url),
        relevance: grade,
      };
    });
}

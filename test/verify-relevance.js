/**
 * Offline relevance regression tests.
 *
 * Run:
 *   node test/verify-relevance.js
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEngineResults } from '../src/merger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, 'fixtures', 'relevance');

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed += 1;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed += 1;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref') parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(actual, expected) {
  return actual === expected || actual.endsWith(`.${expected}`);
}

async function readJson(name) {
  return JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
}

async function readQueries() {
  const text = await readFile(path.join(fixtureDir, 'queries.jsonl'), 'utf8');
  return text.trim().split(/\n+/).map(line => JSON.parse(line));
}

async function readQrels() {
  const text = await readFile(path.join(fixtureDir, 'qrels.tsv'), 'utf8');
  const qrels = new Map();
  for (const line of text.trim().split(/\n+/)) {
    const [qid, , url, relRaw] = line.split(/\s+/);
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(normalizeUrl(url), Number(relRaw));
  }
  return qrels;
}

function relevance(qrels, qid, url) {
  return qrels.get(qid)?.get(normalizeUrl(url)) ?? 0;
}

function hasJudgment(qrels, qid, url) {
  return qrels.get(qid)?.has(normalizeUrl(url)) ?? false;
}

function sourceIndex(engineMap) {
  const index = new Map();
  for (const [engine, results] of engineMap.entries()) {
    for (const result of results) {
      const key = normalizeUrl(result.url);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(engine);
    }
  }
  return index;
}

function hasTraceableProvenance(item, index) {
  const sources = index.get(normalizeUrl(item.url));
  return (
    sources instanceof Set &&
    Array.isArray(item.engines) &&
    item.engines.length > 0 &&
    item.engines.every(engine => sources.has(engine))
  );
}

function dcg(rels) {
  return rels.reduce((sum, rel, index) => {
    const gain = (2 ** rel) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);
}

function ndcgAt(runRels, idealRels, k) {
  const actual = dcg(runRels.slice(0, k));
  const ideal = dcg([...idealRels].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 0 : actual / ideal;
}

function mrrAt(runRels, k) {
  const index = runRels.slice(0, k).findIndex(rel => rel >= 2);
  return index === -1 ? 0 : 1 / (index + 1);
}

function precisionAt(runRels, k) {
  return runRels.slice(0, k).filter(rel => rel >= 2).length / k;
}

const queries = await readQueries();
const engineRuns = await readJson('engine-runs.json');
const expectedDomains = await readJson('expected-domains.json');
const qrels = await readQrels();

const perQuery = [];
const byIntent = new Map();
const knownEngines = new Set(['official', 'ddg', 'bing', 'brave', 'google', 'reddit', 'github', 'stackoverflow', 'hackernews', 'npm', 'wikipedia']);
const queryIds = new Set();
const qrelCoverage = new Map([...qrels.keys()].map(qid => [qid, new Set()]));
let malformedFixtureRows = 0;
let duplicateRunUrls = 0;
let unknownEngines = 0;

for (const query of queries) {
  if (queryIds.has(query.qid)) duplicateRunUrls += 1;
  queryIds.add(query.qid);

  const seenRunUrls = new Set();
  for (const [engine, rows] of Object.entries(engineRuns[query.qid] || {})) {
    if (!knownEngines.has(engine)) unknownEngines += 1;
    for (const row of rows) {
      const key = normalizeUrl(row.url);
      if (!row.title || !row.url || !row.snippet || !domainOf(row.url)) malformedFixtureRows += 1;
      if (seenRunUrls.has(key)) duplicateRunUrls += 1;
      seenRunUrls.add(key);
      if (qrelCoverage.has(query.qid) && qrelCoverage.get(query.qid).has(key) === false && qrels.get(query.qid).has(key)) {
        qrelCoverage.get(query.qid).add(key);
      }
    }
  }
}

for (const query of queries) {
  const engineMap = new Map(Object.entries(engineRuns[query.qid] || {}));
  const provenanceIndex = sourceIndex(engineMap);
  const merged = mergeEngineResults(engineMap, query.query, query.limit, query.intent);
  const runRels = merged.map(item => relevance(qrels, query.qid, item.url));
  const idealRels = [...(qrels.get(query.qid)?.values() || [])];
  const top3Domains = merged.slice(0, 3).map(item => domainOf(item.url));
  const top5Domains = merged.slice(0, 5).map(item => domainOf(item.url));
  const expected = expectedDomains[query.qid] || {};

  const expectedOk = (expected.must_have_top3 || []).every(domain =>
    top3Domains.some(actual => domainMatches(actual, domain))
  );
  const blockedOk = !(expected.blocked_top5 || []).some(domain =>
    top5Domains.some(actual => domainMatches(actual, domain))
  );

  const metrics = {
    qid: query.qid,
    intent: query.intent,
    ndcg5: ndcgAt(runRels, idealRels, 5),
    ndcg10: ndcgAt(runRels, idealRels, 10),
    mrr10: mrrAt(runRels, 10),
    p5: precisionAt(runRels, 5),
    coverage10: runRels.slice(0, 10).some(rel => rel >= 2) ? 1 : 0,
    top1Relevant: runRels[0] >= 2 ? 1 : 0,
    top3Judged: merged.slice(0, 3).every(item => hasJudgment(qrels, query.qid, item.url)) ? 1 : 0,
    provenanceOk: merged.every((item, index) =>
      item.rank === index + 1 &&
      item.title &&
      item.url &&
      item.snippet &&
      Array.isArray(item.engines) &&
      item.engines.length > 0 &&
      item.engines.every(engine => knownEngines.has(engine)) &&
      hasTraceableProvenance(item, provenanceIndex)
    ) ? 1 : 0,
    noiseTop2Clean: top3Domains.slice(0, 2).every(domain => !domainMatches(domain, 'example.com')) ? 1 : 0,
    expectedOk: expectedOk ? 1 : 0,
    blockedOk: blockedOk ? 1 : 0,
  };
  perQuery.push(metrics);
  if (!byIntent.has(query.intent)) byIntent.set(query.intent, []);
  byIntent.get(query.intent).push(metrics);
}

function average(items, key) {
  return items.reduce((sum, item) => sum + item[key], 0) / items.length;
}

const overall = {
  ndcg5: average(perQuery, 'ndcg5'),
  ndcg10: average(perQuery, 'ndcg10'),
  mrr10: average(perQuery, 'mrr10'),
  p5: average(perQuery, 'p5'),
  coverage10: average(perQuery, 'coverage10'),
  top1Relevant: average(perQuery, 'top1Relevant'),
  top3Judged: average(perQuery, 'top3Judged'),
  provenanceOk: average(perQuery, 'provenanceOk'),
  noiseTop2Clean: average(perQuery, 'noiseTop2Clean'),
  expectedDomain3: average(perQuery, 'expectedOk'),
  blockedDomain5: average(perQuery, 'blockedOk'),
};

console.log(`\n${INFO} fixture audit`);
assert(queryIds.size === queries.length, 'query ids are unique');
assert(malformedFixtureRows === 0, 'engine fixture rows have title, url, snippet, and valid domain', `${malformedFixtureRows} malformed rows`);
assert(duplicateRunUrls === 0, 'engine fixtures have no duplicate URLs per query', `${duplicateRunUrls} duplicates`);
assert(unknownEngines === 0, 'engine fixtures use known engine names', `${unknownEngines} unknown engines`);
for (const query of queries) {
  assert((qrels.get(query.qid)?.size ?? 0) >= 3, `${query.qid} has at least 3 relevance judgments`);
  assert((qrelCoverage.get(query.qid)?.size ?? 0) === (qrels.get(query.qid)?.size ?? 0), `${query.qid} qrels are represented in engine fixtures`);
}

console.log(`\n${INFO} overall relevance`);
assert(queries.length === 20, 'uses 20 fixed queries', `got ${queries.length}`);
assert(overall.ndcg5 >= 0.78, `nDCG@5 >= 0.78`, overall.ndcg5.toFixed(3));
assert(overall.ndcg10 >= 0.78, `nDCG@10 >= 0.78`, overall.ndcg10.toFixed(3));
assert(overall.mrr10 >= 0.80, `MRR@10 >= 0.80`, overall.mrr10.toFixed(3));
assert(overall.p5 + 1e-9 >= 0.55, `P@5 >= 0.55`, overall.p5.toFixed(3));
assert(overall.coverage10 === 1, `Coverage@10 is complete`, overall.coverage10.toFixed(3));
assert(overall.top1Relevant >= 0.95, `Top1Relevant >= 0.95`, overall.top1Relevant.toFixed(3));
assert(overall.top3Judged >= 0.95, `Top3Judged >= 0.95`, overall.top3Judged.toFixed(3));
assert(overall.provenanceOk === 1, `Provenance metadata is traceable to fixtures`, overall.provenanceOk.toFixed(3));
assert(overall.noiseTop2Clean === 1, `Noise domains do not degrade top 2`, overall.noiseTop2Clean.toFixed(3));
assert(overall.expectedDomain3 >= 0.85, `ExpectedDomain@3 >= 0.85`, overall.expectedDomain3.toFixed(3));
assert(overall.blockedDomain5 === 1, `BlockedDomain@5 is clean`, overall.blockedDomain5.toFixed(3));

const intentThresholds = {
  docs: 0.85,
  code: 0.75,
  factual: 0.75,
  discussion: 0.65,
  general: 0.70,
};

console.log(`\n${INFO} per-intent relevance`);
for (const [intent, items] of byIntent.entries()) {
  const value = average(items, 'ndcg5');
  const threshold = intentThresholds[intent] ?? 0.70;
  assert(value >= threshold, `${intent} nDCG@5 >= ${threshold}`, value.toFixed(3));
}

console.log(`\n${INFO} per-query floor`);
for (const item of perQuery) {
  assert(item.ndcg5 >= 0.35, `${item.qid} nDCG@5 >= 0.35`, item.ndcg5.toFixed(3));
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { canonicalizeUrlForJudging } from '../lib/metrics.js';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

if (process.argv.includes('--help')) {
  process.stdout.write([
    'Usage: node benchmark/scripts/auto-label-qrels.js --pool blind-judging-pool.jsonl --base benchmark/fixtures/qrels.tsv --out qrels.auto.tsv [--review review.jsonl]',
    '',
    'Conservatively bootstraps qrels from an unjudged blind pool.',
    'Exact base qrels are preserved. Obvious official/domain siblings and obvious noise are auto-labeled.',
    'Uncertain rows are left out and should still be human judged before public quality claims.',
    '',
  ].join('\n'));
  process.exit(0);
}

const poolFile = argValue('--pool', 'benchmark/runs/latest-no-key/blind-judging-pool.jsonl');
const baseFile = argValue('--base', 'benchmark/fixtures/qrels.tsv');
const outputFile = argValue('--out');
const reviewFile = argValue('--review');

if (!outputFile) {
  console.error('Missing --out qrels.auto.tsv');
  process.exit(2);
}

const baseRows = parseQrels(await readFile(baseFile, 'utf8'));
const poolRows = parseJsonl(await readFile(poolFile, 'utf8'));
const baseByKey = new Map(baseRows.map(row => [row.key, row]));
const baseByQid = groupBy(baseRows, row => row.qid);
const merged = new Map(baseRows.map(row => [row.key, row]));
const review = [];
const stats = {
  pool_rows: poolRows.length,
  preserved_base_rows: baseRows.length,
  exact_base: 0,
  auto_3: 0,
  auto_2: 0,
  auto_0: 0,
  uncertain: 0,
};

for (const row of poolRows) {
  const qid = String(row.qid || '');
  const url = canonicalizeUrlForJudging(row.canonical_url || row.url || '');
  const key = `${qid}\t${url}`;
  if (baseByKey.has(key)) {
    stats.exact_base += 1;
    continue;
  }

  const label = autoLabel(row, baseByQid.get(qid) || []);
  if (label.relevance == null) {
    stats.uncertain += 1;
    review.push({ ...reviewRow(row, label), action: 'needs_judgment' });
    continue;
  }

  if (label.relevance === 3) stats.auto_3 += 1;
  if (label.relevance === 2) stats.auto_2 += 1;
  if (label.relevance === 0) stats.auto_0 += 1;

  merged.set(key, { qid, url, relevance: label.relevance, key });
  review.push({ ...reviewRow(row, label), action: 'auto_labeled' });
}

const qrels = [...merged.values()]
  .sort((a, b) => a.qid.localeCompare(b.qid) || a.url.localeCompare(b.url))
  .map(row => `${row.qid}\t0\t${row.url}\t${row.relevance}`)
  .join('\n') + (merged.size ? '\n' : '');

await writeFile(outputFile, qrels);
if (reviewFile) {
  await writeFile(reviewFile, review.map(row => JSON.stringify(row)).join('\n') + (review.length ? '\n' : ''));
}

console.error(`wrote ${merged.size} qrels to ${outputFile}`);
console.error(`preserved base rows: ${stats.preserved_base_rows}`);
console.error(`pool rows: ${stats.pool_rows}; exact base: ${stats.exact_base}; auto rel3: ${stats.auto_3}; auto rel2: ${stats.auto_2}; auto rel0: ${stats.auto_0}; uncertain: ${stats.uncertain}`);
if (reviewFile) console.error(`review rows: ${reviewFile}`);

function autoLabel(poolRow, baseRowsForQuery) {
  const url = poolRow.canonical_url || poolRow.url || '';
  const title = poolRow.title || '';
  const snippet = poolRow.snippet || '';
  const query = poolRow.query || '';
  const signal = urlSignal(url);
  const text = `${title} ${snippet} ${signal.path}`.toLowerCase();
  const queryTokens = keywordTokens(query);
  const textCoverage = coverage(queryTokens, `${title} ${snippet} ${signal.hostname} ${signal.path}`);
  const relevantBase = baseRowsForQuery.filter(row => row.relevance >= 2);
  const strongBase = baseRowsForQuery.filter(row => row.relevance >= 3);
  const relevantDomains = new Set(relevantBase.map(row => urlSignal(row.url).domain).filter(Boolean));
  const strongDomains = new Set(strongBase.map(row => urlSignal(row.url).domain).filter(Boolean));

  if (isObviousNoise(signal, title, snippet)) {
    return { relevance: 0, reason: 'obvious_noise' };
  }

  if (strongDomains.has(signal.domain) && isOfficialResource(signal, text) && textCoverage >= 0.35) {
    return { relevance: 3, reason: 'official_strong_domain_match' };
  }

  if (relevantDomains.has(signal.domain) && textCoverage >= 0.3) {
    return { relevance: 2, reason: 'known_relevant_domain_sibling' };
  }

  if (isSearchOrListingPage(signal) && textCoverage < 0.5) {
    return { relevance: 0, reason: 'search_or_listing_page' };
  }

  if (isLowSignalHost(signal) && !relevantDomains.has(signal.domain)) {
    return { relevance: 0, reason: 'low_signal_host' };
  }

  return { relevance: null, reason: 'uncertain' };
}

function isOfficialResource(signal, text) {
  return (
    /^(docs|developer|developers|api)\./i.test(signal.hostname) ||
    /^\/(docs|documentation|api|reference|guide|guides|manual|tutorial|tutorials|library|learn|spec|standards?)(\/|$)/i.test(signal.path) ||
    /\b(official|docs|documentation|api reference|specification|standard|manual)\b/i.test(text) ||
    signal.hostname.endsWith('.gov') ||
    signal.hostname.endsWith('.edu')
  );
}

function isSearchOrListingPage(signal) {
  return (
    /^\/search\/?$/i.test(signal.path) ||
    signal.path.includes('/search') ||
    signal.searchParams.has('q') ||
    signal.searchParams.has('query')
  );
}

function isLowSignalHost(signal) {
  return (
    ['medium.com', 'dev.to', 'hashnode.dev', 'hackernoon.com', 'pinterest.com', 'quora.com'].includes(signal.domain) ||
    signal.hostname.startsWith('blog.') ||
    signal.hostname.endsWith('.substack.com')
  );
}

function isObviousNoise(signal, title, snippet) {
  const text = `${title} ${snippet}`.toLowerCase();
  return (
    signal.domain === 'example.com' ||
    signal.domain === 'example.net' ||
    signal.domain === 'invalid' ||
    /\b(sign in|login|shopping cart|advertisement|sponsored)\b/.test(text) ||
    /\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i.test(signal.path) && text.length < 30
  );
}

function keywordTokens(text) {
  const stop = new Set([
    'a', 'an', 'and', 'api', 'best', 'define', 'documentation', 'docs', 'file',
    'for', 'guide', 'history', 'how', 'in', 'is', 'of', 'official', 'reference',
    'the', 'to', 'what', 'who', 'with',
  ]);
  return [...new Set(String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) || [])]
    .filter(token => token.length >= 3 && !stop.has(token));
}

function coverage(tokens, text) {
  if (!tokens.length) return 0;
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  const hits = tokens.filter(token => normalized.includes(token)).length;
  return hits / tokens.length;
}

function urlSignal(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return {
      hostname: parsed.hostname.replace(/^www\./i, '').toLowerCase(),
      domain: registrableDomain(parsed.hostname),
      path: parsed.pathname || '/',
      searchParams: parsed.searchParams,
    };
  } catch {
    return { hostname: '', domain: '', path: '/', searchParams: new URLSearchParams() };
  }
}

function registrableDomain(hostname) {
  const parts = String(hostname || '').replace(/^www\./i, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function parseQrels(text) {
  return text
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line, index) => {
      const [qid, , rawUrl, relevanceRaw] = line.split(/\s+/);
      if (!qid || !rawUrl || relevanceRaw == null) {
        throw new Error(`qrels line ${index + 1}: expected "qid 0 url relevance"`);
      }
      const url = canonicalizeUrlForJudging(rawUrl);
      return {
        qid,
        url,
        relevance: Number(relevanceRaw),
        key: `${qid}\t${url}`,
      };
    });
}

function parseJsonl(text) {
  return text.trim().split(/\n+/).filter(Boolean).map(line => JSON.parse(line));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function reviewRow(row, label) {
  return {
    pool_id: row.pool_id,
    qid: row.qid,
    query: row.query,
    url: row.url,
    canonical_url: row.canonical_url || canonicalizeUrlForJudging(row.url),
    title: row.title,
    relevance: label.relevance,
    reason: label.reason,
  };
}

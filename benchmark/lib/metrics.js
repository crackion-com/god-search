import { readFile } from 'node:fs/promises';

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export async function readQrels(file) {
  const text = await readFile(file, 'utf8');
  const qrels = new Map();
  const strictQrels = new Map();

  for (const line of text.trim().split(/\n+/)) {
    const [qid, , url, relRaw] = line.split(/\s+/);
    if (!qid || !url) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    if (!strictQrels.has(qid)) strictQrels.set(qid, new Map());
    qrels.get(qid).set(canonicalizeUrlForJudging(url), Number(relRaw));
    strictQrels.get(qid).set(exactUrlKey(url), Number(relRaw));
  }

  qrels.strict = strictQrels;
  return qrels;
}

export function exactUrlKey(url) {
  return String(url || '').trim();
}

export function canonicalizeUrlForJudging(url) {
  try {
    const parsed = new URL(exactUrlKey(url));
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith('utm_') ||
        lower === 'ref' ||
        lower === 'fbclid' ||
        lower === 'gclid' ||
        lower === 'mc_cid' ||
        lower === 'mc_eid'
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return exactUrlKey(url).replace(/\/$/, '');
  }
}

export const normalizeUrl = canonicalizeUrlForJudging;

export function relevance(qrels, qid, url) {
  return qrels.get(qid)?.get(canonicalizeUrlForJudging(url)) ?? 0;
}

export function strictRelevance(qrels, qid, url) {
  return qrels.strict?.get(qid)?.get(exactUrlKey(url)) ?? 0;
}

export function hasJudgment(qrels, qid, url) {
  return qrels.get(qid)?.has(canonicalizeUrlForJudging(url)) ?? false;
}

export function qrelsAreShallow(queries, qrels, depth = 20) {
  return queries.some(query => {
    const expected = Math.min(query.limit || depth, depth);
    return (qrels.get(query.qid)?.size || 0) < expected;
  });
}

export function summarizeJudgmentDepth(queries, qrels, depth = 20) {
  const perQuery = queries.map(query => {
    const expected = Math.min(query.limit || depth, depth);
    const judged = qrels.get(query.qid)?.size || 0;
    return {
      qid: query.qid,
      expected_depth: expected,
      judged,
      coverage: expected ? Math.min(judged, expected) / expected : 0,
      shallow: judged < expected,
    };
  });
  const expectedTotal = perQuery.reduce((sum, row) => sum + row.expected_depth, 0);
  const judgedTotal = perQuery.reduce((sum, row) => sum + Math.min(row.judged, row.expected_depth), 0);

  return {
    depth,
    queries: perQuery.length,
    shallow_queries: perQuery.filter(row => row.shallow).length,
    expected_judgments_at_depth: expectedTotal,
    judged_at_depth: judgedTotal,
    coverage_at_depth: expectedTotal ? judgedTotal / expectedTotal : 0,
    per_query: perQuery,
  };
}

function dcg(rels) {
  return rels.reduce((sum, rel, index) => {
    const gain = (2 ** rel) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);
}

export function ndcgAt(runRels, idealRels, k) {
  const actual = dcg(runRels.slice(0, k));
  const ideal = dcg([...idealRels].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 0 : actual / ideal;
}

export function mrrAt(runRels, k) {
  const index = runRels.slice(0, k).findIndex(rel => rel >= 2);
  return index === -1 ? 0 : 1 / (index + 1);
}

export function precisionAt(runRels, k) {
  return runRels.slice(0, k).filter(rel => rel >= 2).length / k;
}

export function recallAt(runRels, idealRels, k) {
  const relevantTotal = idealRels.filter(rel => rel >= 2).length;
  if (relevantTotal === 0) return 0;
  return runRels.slice(0, k).filter(rel => rel >= 2).length / relevantTotal;
}

export function responseIsValid(run) {
  if (!run || run.error) return false;
  if (!Array.isArray(run.results)) return false;
  return run.results.every(item =>
    item &&
    typeof item.title === 'string' &&
    item.title.trim() &&
    typeof item.url === 'string' &&
    /^https?:\/\//i.test(item.url)
  );
}

export function evaluateSystem({ system, queries, qrels, runs }) {
  const runsByQid = new Map(runs.map(run => [run.qid, run]));
  const perQuery = queries.map(query => {
    const run = runsByQid.get(query.qid) || { qid: query.qid, results: [], error: 'missing run' };
    const valid = responseIsValid(run) ? 1 : 0;
    const results = valid ? run.results : [];
    const runRels = results.map(item => relevance(qrels, query.qid, item.url));
    const strictRunRels = results.map(item => strictRelevance(qrels, query.qid, item.url));
    const idealRels = [...(qrels.get(query.qid)?.values() || [])];
    const strictIdealRels = [...(qrels.strict?.get(query.qid)?.values() || [])];
    const top20 = results.slice(0, 20);
    const judgedCount20 = top20.filter(item => hasJudgment(qrels, query.qid, item.url)).length;
    const unjudgedCount20 = top20.length - judgedCount20;
    const judgedCoverage20 = top20.length ? judgedCount20 / top20.length : 0;

    return {
      system,
      qid: query.qid,
      intent: query.intent,
      valid_response: valid,
      latency_ms: Number.isFinite(run.latency_ms) ? run.latency_ms : null,
      result_count: results.length,
      ndcg10: ndcgAt(runRels, idealRels, 10),
      mrr10: mrrAt(runRels, 10),
      p5: precisionAt(runRels, 5),
      recall20: recallAt(runRels, idealRels, 20),
      strict_ndcg10: ndcgAt(strictRunRels, strictIdealRels, 10),
      strict_mrr10: mrrAt(strictRunRels, 10),
      strict_p5: precisionAt(strictRunRels, 5),
      strict_recall20: recallAt(strictRunRels, strictIdealRels, 20),
      judged_count20: judgedCount20,
      unjudged_count20: unjudgedCount20,
      judged_coverage20: judgedCoverage20,
      unjudged_rate20: top20.length ? unjudgedCount20 / top20.length : 0,
      error: run.error || null,
    };
  });

  return {
    system,
    perQuery,
    aggregate: aggregateMetrics(perQuery),
    byIntent: aggregateByIntent(perQuery),
  };
}

export function aggregateRepeatedEvaluations(evaluations) {
  if (!evaluations.length) {
    throw new Error('aggregateRepeatedEvaluations requires at least one evaluation');
  }

  if (evaluations.length === 1) {
    return {
      ...evaluations[0],
      repeats: 1,
      repeatAggregates: [evaluations[0].aggregate],
    };
  }

  const first = evaluations[0];
  const perQueryGroups = new Map();
  for (const evaluation of evaluations) {
    for (const row of evaluation.perQuery) {
      if (!perQueryGroups.has(row.qid)) perQueryGroups.set(row.qid, []);
      perQueryGroups.get(row.qid).push(row);
    }
  }

  const perQuery = [...perQueryGroups.values()]
    .map(averageMetricRows)
    .sort((a, b) => a.qid.localeCompare(b.qid));

  return {
    system: first.system,
    perQuery,
    aggregate: aggregateMetrics(perQuery),
    byIntent: aggregateByIntent(perQuery),
    repeats: evaluations.length,
    repeatAggregates: evaluations.map(evaluation => evaluation.aggregate),
  };
}

function averageMetricRows(rows) {
  const first = rows[0];
  const errors = rows.map(row => row.error).filter(Boolean);
  const numericKeys = [
    'valid_response',
    'latency_ms',
    'result_count',
    'ndcg10',
    'mrr10',
    'p5',
    'recall20',
    'strict_ndcg10',
    'strict_mrr10',
    'strict_p5',
    'strict_recall20',
    'judged_count20',
    'unjudged_count20',
    'judged_coverage20',
    'unjudged_rate20',
  ];
  const averaged = {
    system: first.system,
    qid: first.qid,
    intent: first.intent,
    repeats: rows.length,
    error_count: errors.length,
    error: errors.length ? `${errors.length}/${rows.length} repeats failed` : null,
  };

  for (const key of numericKeys) {
    const values = rows.map(row => row[key]).filter(value => Number.isFinite(value));
    averaged[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  return averaged;
}

export function aggregateMetrics(rows) {
  const count = rows.length || 1;
  const latencies = rows
    .map(row => row.latency_ms)
    .filter(value => Number.isFinite(value));
  const latencyMsAvg = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  const latencyMsP95 = percentile(latencies, 0.95);
  const aggregate = {
    queries: rows.length,
    valid_response: average(rows, 'valid_response'),
    ndcg10: average(rows, 'ndcg10'),
    mrr10: average(rows, 'mrr10'),
    p5: average(rows, 'p5'),
    recall20: average(rows, 'recall20'),
    strict_ndcg10: average(rows, 'strict_ndcg10'),
    strict_mrr10: average(rows, 'strict_mrr10'),
    strict_p5: average(rows, 'strict_p5'),
    strict_recall20: average(rows, 'strict_recall20'),
    judged_coverage20: average(rows, 'judged_coverage20'),
    unjudged_rate20: average(rows, 'unjudged_rate20'),
    unjudged_count20: rows.reduce((sum, row) => sum + (Number(row.unjudged_count20) || 0), 0),
    latency_ms_avg: latencyMsAvg,
    latency_ms_p95: latencyMsP95,
    latency_score: latencyScore(latencyMsP95),
    error_count: rows.filter(row => row.error).length,
    count,
  };

  return {
    ...aggregate,
    overall_score: overallScore(aggregate),
  };
}

function aggregateByIntent(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.intent)) groups.set(row.intent, []);
    groups.get(row.intent).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([intent, items]) => [intent, aggregateMetrics(items)]));
}

function average(rows, key) {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / rows.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function overallScore(aggregate) {
  const weightedMetrics = [
    ['valid_response', 0.10],
    ['ndcg10', 0.30],
    ['mrr10', 0.15],
    ['p5', 0.10],
    ['recall20', 0.15],
    ['judged_coverage20', 0.10],
    ['latency_score', 0.10],
  ];
  let weightedSum = 0;
  let weightSum = 0;

  for (const [key, weight] of weightedMetrics) {
    const value = aggregate[key];
    if (!Number.isFinite(value)) continue;
    weightedSum += clamp01(value) * weight;
    weightSum += weight;
  }

  return weightSum ? Number(((weightedSum / weightSum) * 100).toFixed(1)) : 0;
}

function latencyScore(p95Ms) {
  if (!Number.isFinite(p95Ms)) return null;
  if (p95Ms <= 1000) return 1;
  if (p95Ms >= 10000) return 0;
  return 1 - ((p95Ms - 1000) / 9000);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function formatNumber(value, digits = 3) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return Number(value).toFixed(digits);
}

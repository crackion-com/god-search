import { canonicalizeUrlForJudging, hasJudgment } from './metrics.js';

const DEFAULT_POOL_DEPTH = 20;
const BLIND_LEAK_FIELDS = new Set([
  'system',
  'systems',
  'engine',
  'engines',
  'rank',
  'position',
  'profile_mode',
  'source',
  'source_system',
]);
const VALID_RELEVANCE_GRADES = new Set([0, 1, 2, 3]);

export function buildBlindJudgingPool({ queries, rawRuns, depth = DEFAULT_POOL_DEPTH }) {
  const queriesByQid = new Map(queries.map(query => [query.qid, query]));
  const pooledByKey = new Map();

  for (const runs of Object.values(rawRuns)) {
    if (!Array.isArray(runs)) continue;

    for (const run of runs) {
      const query = queriesByQid.get(run.qid);
      const results = Array.isArray(run.results) ? run.results.slice(0, depth) : [];

      for (const result of results) {
        if (!result || typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url)) continue;

        const canonicalUrl = canonicalizeUrlForJudging(result.url);
        const key = `${run.qid}\t${canonicalUrl}`;
        if (pooledByKey.has(key)) continue;

        pooledByKey.set(key, {
          qid: run.qid,
          query: query?.query || run.query || '',
          intent: query?.intent || run.intent || null,
          url: result.url,
          canonical_url: canonicalUrl,
          title: stringOrEmpty(result.title),
          snippet: stringOrEmpty(result.snippet),
          relevance: null,
        });
      }
    }
  }

  return [...pooledByKey.values()]
    .sort((a, b) =>
      a.qid.localeCompare(b.qid) ||
      a.canonical_url.localeCompare(b.canonical_url) ||
      a.url.localeCompare(b.url)
    )
    .map((row, index) => ({
      pool_id: `pool-${String(index + 1).padStart(5, '0')}`,
      ...row,
    }));
}

export function buildJudgmentPriorityQueue({ queries, rawRuns, qrels, depth = DEFAULT_POOL_DEPTH, limit = null }) {
  const pool = buildBlindJudgingPool({ queries, rawRuns, depth });
  const observations = collectObservations(rawRuns, depth);
  const depthByQid = new Map(queries.map(query => [query.qid, Math.min(query.limit || depth, depth)]));

  const rows = pool
    .filter(row => !hasJudgment(qrels, row.qid, row.canonical_url))
    .map(row => {
      const observed = observations.get(`${row.qid}\t${row.canonical_url}`) || {
        count: 0,
        systems: new Set(),
        bestRank: depth,
      };
      const expectedDepth = depthByQid.get(row.qid) || depth;
      const queryJudged = qrels.get(row.qid)?.size || 0;
      const queryCoverage = expectedDepth ? Math.min(queryJudged, expectedDepth) / expectedDepth : 1;
      const score = priorityScore({ observed, queryCoverage, depth });

      return {
        pool_id: row.pool_id,
        qid: row.qid,
        query: row.query,
        intent: row.intent,
        url: row.url,
        canonical_url: row.canonical_url,
        title: row.title,
        snippet: row.snippet,
        relevance: row.relevance,
        priority_score: score,
        priority_band: score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low',
        priority_reason: priorityReason({ observed, queryCoverage }),
        occurrence_count: observed.count,
        observed_system_count: observed.systems.size,
        query_judgment_coverage: queryCoverage,
      };
    })
    .sort((a, b) =>
      b.priority_score - a.priority_score ||
      a.qid.localeCompare(b.qid) ||
      a.canonical_url.localeCompare(b.canonical_url)
    );

  const limited = Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  return limited.map((row, index) => ({
    queue_id: `judge-${String(index + 1).padStart(5, '0')}`,
    ...row,
  }));
}

export function serializeJsonl(rows) {
  if (!rows.length) return '';
  return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
}

export function validateBlindJudgingPool(rows, { requireJudgments = false } = {}) {
  const errors = [];
  let judgedCount = 0;
  let unjudgedCount = 0;

  rows.forEach((row, index) => {
    const label = row?.pool_id || `row ${index + 1}`;
    if (!row || typeof row !== 'object') {
      errors.push(`${label}: row must be an object`);
      return;
    }

    for (const field of Object.keys(row)) {
      if (BLIND_LEAK_FIELDS.has(field)) {
        errors.push(`${label}: blind pool must not expose "${field}"`);
      }
    }

    if (!row.qid) errors.push(`${label}: missing qid`);
    if (!row.query) errors.push(`${label}: missing query`);
    if (!/^https?:\/\//i.test(row.url || '')) errors.push(`${label}: invalid url`);
    if (!/^https?:\/\//i.test(row.canonical_url || '')) errors.push(`${label}: invalid canonical_url`);

    if (row.relevance == null || row.relevance === '') {
      unjudgedCount += 1;
      if (requireJudgments) errors.push(`${label}: missing relevance`);
    } else if (!VALID_RELEVANCE_GRADES.has(Number(row.relevance))) {
      errors.push(`${label}: relevance must be 0, 1, 2, or 3`);
    } else {
      judgedCount += 1;
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    rows: rows.length,
    judged_count: judgedCount,
    unjudged_count: unjudgedCount,
  };
}

export function validateJudgmentPriorityQueue(rows) {
  const validationRows = rows.map(({ queue_id, priority_score, priority_band, priority_reason, occurrence_count, observed_system_count, query_judgment_coverage, ...row }) => row);
  const validation = validateBlindJudgingPool(validationRows);
  const errors = [...validation.errors];

  rows.forEach((row, index) => {
    const label = row?.queue_id || `row ${index + 1}`;
    if (!row?.queue_id) errors.push(`${label}: missing queue_id`);
    if (!Number.isFinite(row?.priority_score)) errors.push(`${label}: missing priority_score`);
    if (!['high', 'medium', 'low'].includes(row?.priority_band)) errors.push(`${label}: invalid priority_band`);
    if (!Number.isInteger(row?.occurrence_count) || row.occurrence_count < 0) errors.push(`${label}: invalid occurrence_count`);
    if (!Number.isInteger(row?.observed_system_count) || row.observed_system_count < 0) errors.push(`${label}: invalid observed_system_count`);
    if (!Number.isFinite(row?.query_judgment_coverage)) errors.push(`${label}: invalid query_judgment_coverage`);
  });

  return {
    ...validation,
    ok: errors.length === 0,
    errors,
  };
}

export function poolRowsToQrels(rows, { requireJudgments = true } = {}) {
  const validation = validateBlindJudgingPool(rows, { requireJudgments });
  if (!validation.ok) {
    const message = validation.errors.slice(0, 10).join('\n');
    throw new Error(`Invalid blind judging pool:\n${message}`);
  }

  const judgedRows = rows
    .filter(row => row.relevance != null && row.relevance !== '')
    .map(row => ({
      qid: String(row.qid),
      url: row.canonical_url || canonicalizeUrlForJudging(row.url),
      relevance: Number(row.relevance),
    }))
    .sort((a, b) => a.qid.localeCompare(b.qid) || a.url.localeCompare(b.url));

  return judgedRows.map(row => `${row.qid}\t0\t${row.url}\t${row.relevance}`).join('\n') + (judgedRows.length ? '\n' : '');
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function collectObservations(rawRuns, depth) {
  const observations = new Map();

  for (const [system, runs] of Object.entries(rawRuns)) {
    if (!Array.isArray(runs)) continue;

    for (const run of runs) {
      const results = Array.isArray(run.results) ? run.results.slice(0, depth) : [];
      results.forEach((result, index) => {
        if (!result || typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url)) return;
        const canonicalUrl = canonicalizeUrlForJudging(result.url);
        const key = `${run.qid}\t${canonicalUrl}`;
        if (!observations.has(key)) {
          observations.set(key, { count: 0, systems: new Set(), bestRank: depth });
        }
        const observed = observations.get(key);
        observed.count += 1;
        observed.systems.add(system);
        observed.bestRank = Math.min(observed.bestRank, index + 1);
      });
    }
  }

  return observations;
}

function priorityScore({ observed, queryCoverage, depth }) {
  const rankWeight = 45 * ((depth - Math.min(observed.bestRank, depth) + 1) / depth);
  const occurrenceWeight = Math.min(20, observed.count * 5);
  const systemWeight = Math.min(20, observed.systems.size * 6);
  const coverageWeight = 15 * (1 - queryCoverage);
  return Number((rankWeight + occurrenceWeight + systemWeight + coverageWeight).toFixed(3));
}

function priorityReason({ observed, queryCoverage }) {
  const reasons = [];
  if (observed.bestRank <= 3) reasons.push('top result');
  else if (observed.bestRank <= 10) reasons.push('top 10 result');
  else reasons.push('pooled result');
  if (observed.systems.size > 1) reasons.push('seen across systems');
  if (queryCoverage < 0.5) reasons.push('low query judgment coverage');
  return reasons.join('; ');
}

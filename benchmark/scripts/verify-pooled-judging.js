#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildBlindJudgingPool,
  buildJudgmentPriorityQueue,
  poolRowsToQrels,
  validateBlindJudgingPool,
  validateJudgmentPriorityQueue,
} from '../lib/blind-judging.js';
import {
  aggregateRepeatedEvaluations,
  canonicalizeUrlForJudging,
  evaluateSystem,
  qrelsAreShallow,
} from '../lib/metrics.js';

assert.equal(
  canonicalizeUrlForJudging('https://Example.com/path/?b=2&utm_source=x&a=1#section'),
  'https://example.com/path/?a=1&b=2',
);

const queries = [
  { qid: 'q1', query: 'alpha', intent: 'docs', limit: 20 },
];
const rawRuns = {
  first: [
    {
      qid: 'q1',
      query: 'alpha',
      results: [
        { title: 'A', url: 'https://example.com/a?utm_source=x', snippet: '' },
        { title: 'B', url: 'https://example.com/b', snippet: '' },
      ],
    },
  ],
  second: [
    {
      qid: 'q1',
      query: 'alpha',
      results: [
        { title: 'A2', url: 'https://example.com/a', snippet: '' },
        { title: 'C', url: 'https://example.com/c#frag', snippet: '' },
      ],
    },
  ],
};

const pool = buildBlindJudgingPool({ queries, rawRuns });
assert.equal(pool.length, 3);
assert.deepEqual(
  pool.map(row => row.canonical_url),
  ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
);
assert.equal(pool.every(row => !Object.hasOwn(row, 'system')), true);
assert.equal(pool.every(row => row.relevance === null), true);
assert.deepEqual(validateBlindJudgingPool(pool), {
  ok: true,
  errors: [],
  rows: 3,
  judged_count: 0,
  unjudged_count: 3,
});

const judgedPool = pool.map((row, index) => ({ ...row, relevance: index === 0 ? 3 : 0 }));
assert.equal(validateBlindJudgingPool(judgedPool, { requireJudgments: true }).ok, true);
assert.equal(
  poolRowsToQrels(judgedPool),
  [
    'q1\t0\thttps://example.com/a\t3',
    'q1\t0\thttps://example.com/b\t0',
    'q1\t0\thttps://example.com/c\t0',
    '',
  ].join('\n'),
);

assert.equal(
  validateBlindJudgingPool([{ ...pool[0], system: 'leak', relevance: 3 }], { requireJudgments: true }).ok,
  false,
);

const qrels = new Map([
  ['q1', new Map([[canonicalizeUrlForJudging('https://example.com/a?utm_source=x'), 3]])],
]);
qrels.strict = new Map([
  ['q1', new Map([['https://example.com/a?utm_source=x', 3]])],
]);
const evaluation = evaluateSystem({
  system: 'strict',
  queries,
  qrels,
  runs: rawRuns.second,
});

assert.equal(evaluation.perQuery[0].mrr10, 1);
assert.equal(evaluation.perQuery[0].strict_mrr10, 0);
assert.equal(evaluation.perQuery[0].judged_count20, 1);
assert.equal(evaluation.perQuery[0].unjudged_rate20, 0.5);
assert.equal(qrelsAreShallow(queries, qrels), true);

const repeated = aggregateRepeatedEvaluations([
  evaluateSystem({
    system: 'repeat',
    queries,
    qrels,
    runs: [{
      qid: 'q1',
      query: 'alpha',
      results: [{ title: 'A', url: 'https://example.com/a?utm_source=x', snippet: '' }],
      latency_ms: 10,
    }],
  }),
  evaluateSystem({
    system: 'repeat',
    queries,
    qrels,
    runs: [{
      qid: 'q1',
      query: 'alpha',
      results: [{ title: 'B', url: 'https://example.com/b', snippet: '' }],
      latency_ms: 30,
    }],
  }),
]);
assert.equal(repeated.repeats, 2);
assert.equal(repeated.perQuery[0].latency_ms, 20);
assert.equal(repeated.perQuery[0].mrr10, 0.5);
assert.equal(repeated.perQuery[0].error_count, 0);
assert.equal(Number.isFinite(repeated.aggregate.overall_score), true);
assert.equal(repeated.aggregate.overall_score > 0, true);

const priorityQueue = buildJudgmentPriorityQueue({ queries, rawRuns, qrels });
assert.equal(priorityQueue.length, 2);
assert.deepEqual(
  priorityQueue.map(row => row.canonical_url),
  ['https://example.com/b', 'https://example.com/c'],
);
assert.equal(priorityQueue[0].queue_id, 'judge-00001');
assert.equal(priorityQueue[0].priority_band, 'high');
assert.equal(priorityQueue.every(row => row.relevance === null), true);
assert.equal(validateJudgmentPriorityQueue(priorityQueue).ok, true);
assert.equal(
  validateJudgmentPriorityQueue([{ ...priorityQueue[0], rank: 1 }]).ok,
  false,
);

process.stdout.write('pooled judging checks passed\n');

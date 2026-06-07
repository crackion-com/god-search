# god-search benchmark

This harness evaluates whether `god-search` is moving toward its public positioning: a free/no-key agent search sidecar that can be trusted by CLI, HTTP, and MCP clients.

It evaluates fixed search queries against qrels with standard IR metrics:

- overall score on a 0-100 scale
- nDCG@10
- MRR@10
- P@5
- Recall@20
- valid response rate
- average and p95 latency

The overall score is a weighted summary for quick comparison: nDCG@10 30%, MRR@10 15%, Recall@20 15%, P@5 10%, valid response rate 10%, judged coverage@20 10%, and p95 latency score 10%. When latency is not measured, as in offline fixture mode, the score renormalizes across the available components.

## Offline

The default benchmark is deterministic and does not require network access or API keys. It merges the checked-in engine fixture with the production merger.

```bash
npm run benchmark
```

Outputs are written to `benchmark/runs/latest-offline/report.md` and `benchmark/runs/latest-offline/results.json`.

The offline report is a deterministic regression check against fixtures. It is not intended as a public leaderboard claim.

Use offline results to catch merger and ranking regressions. Do not use them to claim that `god-search` is the best no-key search sidecar; the fixture is too narrow for that.

## Live

Live mode runs the fixed queries against:

- `god-search-default`: current no-key code path with credential env vars stripped and Brave disabled
- `god-search-keyed`: current code with available credentials and Brave enabled, when supported env vars exist
- `brave-api`: when `BRAVE_SEARCH_API_KEY` exists
- `tavily`: when `TAVILY_API_KEY` exists
- `exa`: when `EXA_API_KEY` exists
- `firecrawl`: when `FIRECRAWL_API_KEY` exists
- `serper`: when `SERPER_API_KEY` exists

```bash
npm run benchmark:live
```

Run only the default no-key profile and skip every keyed/provider baseline:

```bash
npm run benchmark:no-key
```

External baselines are run sequentially with retries for transient HTTP failures and rate limits. Tune with:

- `BENCHMARK_EXTERNAL_DELAY_MS` (default `250`): delay between external baseline queries
- `BENCHMARK_EXTERNAL_RETRIES` (default `2`): retries for 408/409/425/429/5xx or network failures
- `BENCHMARK_REPEATS` or `--repeats N` (default `1`): repeat each profile and provider baseline, then report aggregate metric means while keeping per-repeat runs in `results.json`

Run both offline and live profiles:

```bash
npm run benchmark:all
```

Default output directories:

- `npm run benchmark` -> `benchmark/runs/latest-offline/`
- `npm run benchmark:no-key` -> `benchmark/runs/latest-no-key/`
- `npm run benchmark:live` -> `benchmark/runs/latest-live/`
- `npm run benchmark:all` -> `benchmark/runs/latest-all/`

Live `god-search` runs include two profiles:

- `fast/user-visible`: first response returned to the caller, possibly before background browser engines finish
- `settled/full`: response after background engines have settled

The report keeps these latency columns separate. Do not combine fast latency with settled relevance as though they came from the same response.

Supported options:

```bash
node benchmark/run.js --offline --out /tmp/god-search-benchmark
node benchmark/run.js --live --queries benchmark/fixtures/queries.jsonl --qrels benchmark/fixtures/qrels.tsv
node benchmark/run.js --no-key --repeats 3 --out benchmark/runs/no-key-repeat3
```

### Latest No-Key Snapshot

Latest run: `node benchmark/run.js --no-key --qrels benchmark/runs/latest-no-key/qrels.auto.tsv`

Qrels status: shallow. Coverage is `0.337` at depth 20, with all 26 queries below full depth. Unjudged URLs are scored as `0`, so this snapshot is not a public "best" claim and does not support any "unlimited" claim.

What this snapshot can support:

- `god-search-default` is a working no-key baseline for agent search workflows.
- Fast and settled profiles should be discussed separately because they are different user experiences.
- External paid/API baselines are useful context, not a settled leaderboard.

What it cannot support yet:

- "Best free search for agents."
- "Unlimited search."
- "Better than Tavily/Exa/Firecrawl/Serper" without a deeper judged pool and repeated runs.

| System | Profile | Valid | nDCG@10 | Strict nDCG@10 | MRR@10 | P@5 | Recall@20 | p95 ms | Errors |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| god-search-default-fast | fast/user-visible | 1.000 | 0.722 | 0.511 | 0.962 | 0.600 | 0.745 | 1517 | 0 |
| god-search-default-settled | settled/full | 1.000 | 0.673 | 0.495 | 0.904 | 0.515 | 0.769 | 3507 | 0 |

Provider/API baselines were skipped in the latest snapshot because no paid/API keys were set.

The same run produced `449` deduped URLs in `benchmark/runs/latest-no-key/blind-judging-pool.jsonl`.

### Next No-Key Optimization Loop

Use this order for the next quality wave:

1. Judge `benchmark/runs/latest-no-key/blind-judging-pool.jsonl`.
2. Convert judged rows with `benchmark/scripts/pool-to-qrels.js`.
3. Rerun `npm run benchmark:no-key`.
4. Tune only the categories that lose measured relevance.
5. Repeat until no-key fast and settled profiles both improve on judged `nDCG@10`, `MRR@10`, and useful success.

For a fast bootstrap before full human judging, run:

```bash
npm run benchmark:auto-label
node benchmark/run.js --no-key --qrels benchmark/runs/latest-no-key/qrels.auto.tsv
node benchmark/scripts/analyze-misses.js \
  --results benchmark/runs/latest-no-key/results.json \
  --qrels benchmark/runs/latest-no-key/qrels.auto.tsv
```

Auto labels are conservative heuristics for finding likely misses; they are not public proof. Use the generated `auto-label-review.jsonl` to review every automatic grade before claiming benchmark quality.

Language support already exists for query detection, locale hints, Unicode tokenization, and same-language ranking evidence. The next language step is proof: add multilingual qrels before claiming multilingual quality.

Free vertical engines should be added only when they improve judged results for a clear query class. Good candidates are arXiv for research papers, PyPI for Python package queries, and MDN/package docs for developer documentation.

## Judgments

`fixtures/qrels.tsv` uses TREC-style rows:

```text
qid 0 url relevance
```

Relevance grades are:

- `3`: highly relevant primary source
- `2`: relevant useful source
- `1`: related but weak/noisy source
- `0` or absent: not relevant

The metric code treats grades `2` and `3` as relevant for MRR, precision, and recall. nDCG uses the full graded relevance value.

The fixture qrels are intentionally shallow. Unjudged URLs are scored as `0` in displayed metrics, so quality claims should cite the `Judged@20`/`Unjudged@20` coverage columns and should be refreshed through pooled judging before being treated as settled.

The target proof standard for the public positioning is an expanded, blind-judged pool that can fairly compare the no-key `god-search-default` profile against keyed/provider baselines across repeated runs.

## Blind pooled judging

Every benchmark run writes `blind-judging-pool.jsonl` in its output directory. It deduplicates top results by query and canonical URL while omitting system, engine, rank, and profile fields.

Runs also write `judgment-priority-queue.jsonl`. It contains the unjudged pooled URLs sorted by expected benchmark impact. The priority score is computed from internal rank and repeat/system occurrence signals, but the queue remains blind: it does not expose system names, engine names, profile modes, or ranks to the reviewer.

Fill each row's `relevance` with `0`, `1`, `2`, or `3`, then convert the judged pool back to TREC qrels:

```bash
node benchmark/scripts/pool-to-qrels.js \
  --input benchmark/runs/latest-no-key/blind-judging-pool.jsonl \
  --base benchmark/fixtures/qrels.tsv \
  --out benchmark/runs/latest-no-key/qrels.pooled.tsv
```

Use `--allow-partial` to emit only rows that have been judged.

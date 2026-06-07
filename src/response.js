export function buildSearchResponse({
  query,
  result,
  verbose = false,
  app,
  cache,
} = {}) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const stats = result?.engineStats || {};
  const skipped = Array.isArray(stats.skipped) ? stats.skipped : [];
  const failed = Array.isArray(stats.failed) ? stats.failed : [];
  const pending = Array.isArray(stats.pending) ? stats.pending : [];
  const reasonCodes = [
    ...failed.map(engine => `${engine}:failed`),
    ...pending.map(engine => `${engine}:pending`),
    ...skipped.map(item => `${item.engine}:${item.state || item.reason || 'skipped'}`),
  ];
  const degradationReasons = [
    ...failed.map(engine => `${engine}: ${stats.errors?.[engine] || 'failed'}`),
    ...pending.map(engine => `${engine}: pending`),
    ...skipped.map(item => `${item.engine}: ${item.reason || item.state || 'skipped'}`),
  ];
  const retryAfterMs = skipped.reduce((max, item) => Math.max(max, item.retry_after_ms || 0), 0);
  const hasPending = pending.length > 0;
  const quality = {
    status: result?.partial
        ? (results.length > 0 ? (hasPending ? 'fast_partial' : 'degraded') : 'failed')
      : (result?.fromCache ? 'cached' : 'settled'),
    quorum_met: results.length > 0,
    reason_codes: reasonCodes,
    degradation_reasons: degradationReasons,
    retry_after_ms: retryAfterMs,
  };
  const output = {
    query,
    results: results.map(item => ({
      ...item,
      evidence: item.evidence || {
        engines: item.engines || [],
        cross_engine_count: Array.isArray(item.engines) ? item.engines.length : 0,
        domain: item.domain || '',
      },
    })),
    total: results.length,
    partial: !!result?.partial,
    intent: result?.intent || null,
    quality,
  };

  if (result?.fromCache) output.cached = true;
  if (verbose) {
    output.elapsed_ms = result?.elapsed_ms;
    output.engines = result?.engineStats;
  }

  output.meta = {
    app,
    cache,
  };

  return output;
}

/**
 * cache.js — LRU-TTL cache (256 entries, 10min TTL) + inflight deduplication
 * All logging → console.error.
 */

import { CACHE_CONFIG } from './config.js';

const _cache = new Map(); // key → { time, value }
const _inflight = new Map(); // key → Promise
const PARTIAL_RESULT_FLOOR = 3;
const NON_CACHEABLE_STATUSES = new Set(['blocked', 'failed', 'consent']);
let _now = () => Date.now();
const _stats = {
  hits: 0,
  misses: 0,
  inflightHits: 0,
  writes: 0,
  skippedWrites: 0,
};

export function __setNowForTests(fn) {
  _now = fn || (() => Date.now());
}

export function __resetForTests() {
  _cache.clear();
  _inflight.clear();
  _now = () => Date.now();
  for (const key of Object.keys(_stats)) {
    _stats[key] = 0;
  }
}

function _makeKey(query, opts = {}) {
  const engines = opts.engines ? [...opts.engines].sort().join(',') : 'all';
  const limit = opts.limit ?? 10;
  return `${query.toLowerCase().trim()}|${engines}|${limit}`;
}

function _getCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (_now() - entry.time > CACHE_CONFIG.ttlMs) {
    _cache.delete(key);
    return null;
  }
  // LRU: re-insert to move to end (most-recently-used)
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.value;
}

function _setCache(key, value) {
  // Evict expired entries first
  for (const [k, v] of _cache) {
    if (_now() - v.time > CACHE_CONFIG.ttlMs) _cache.delete(k);
  }
  _cache.delete(key);
  _cache.set(key, { time: _now(), value });
  // Enforce max size — Map insertion order = oldest first
  while (_cache.size > CACHE_CONFIG.maxEntries) {
    _cache.delete(_cache.keys().next().value);
  }
  _stats.writes += 1;
}

function _partialResultFloor(opts = {}) {
  const limit = Number.parseInt(String(opts.limit ?? ''), 10);
  if (!Number.isFinite(limit) || limit < 1) return PARTIAL_RESULT_FLOOR;
  return Math.min(PARTIAL_RESULT_FLOOR, limit);
}

function _cacheDecision(value, opts = {}) {
  if (!value || typeof value !== 'object') return true;
  if (value.noCache === true) return false;
  if (NON_CACHEABLE_STATUSES.has(value.status)) return false;
  if (value.partial !== true) return true;

  const resultCount = Array.isArray(value.results) ? value.results.length : 0;
  return resultCount >= _partialResultFloor(opts);
}

function _setCacheIfCacheable(key, value, opts) {
  if (!_cacheDecision(value, opts)) {
    _stats.skippedWrites += 1;
    return;
  }
  _setCache(key, value);
}

/**
 * Wrap a search function with cache + inflight dedup.
 * fn() must return a result object. The result is cached and returned.
 * Concurrent identical queries share the same in-flight Promise.
 */
export async function withCache(query, opts, fn) {
  const key = _makeKey(query, opts);

  const cached = _getCache(key);
  if (cached) {
    _stats.hits += 1;
    return { ...cached, fromCache: true };
  }
  _stats.misses += 1;

  if (_inflight.has(key)) {
    _stats.inflightHits += 1;
    return _inflight.get(key);
  }

  const promise = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, promise);

  const result = await promise;
  _setCacheIfCacheable(key, result, opts);
  return result;
}

/**
 * Manually update cache with a better result (used by background engine completion).
 */
export function updateCache(query, opts, value) {
  const key = _makeKey(query, opts);
  _setCacheIfCacheable(key, value, opts);
}

export function cacheStats() {
  return {
    size: _cache.size,
    inflight: _inflight.size,
    ttl_ms: CACHE_CONFIG.ttlMs,
    max_entries: CACHE_CONFIG.maxEntries,
    ..._stats,
  };
}

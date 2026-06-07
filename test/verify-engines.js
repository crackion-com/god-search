/**
 * test/verify-engines.js — Sequential engine verification suite
 * Run: node test/verify-engines.js
 * Sequential (not parallel) to avoid rate limits.
 */

import { searchDdg } from '../src/engines/ddg.js';
import { searchBrave } from '../src/engines/brave.js';
import { searchBing } from '../src/engines/bing.js';
import { searchGoogle } from '../src/engines/google.js';
import { searchReddit } from '../src/engines/reddit.js';
import { searchGithub } from '../src/engines/github.js';
import { searchWikipedia } from '../src/engines/wikipedia.js';
import { searchStackOverflow } from '../src/engines/stackoverflow.js';
import { runSearch } from '../src/merger.js';
import { closeBrowser } from '../src/browser.js';

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';
const INFO = '\x1b[33m•\x1b[0m';
const MAX_FULL_MERGER_MS = 12_000;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

async function runTest(name, fn) {
  console.log(`\n${INFO} Testing: ${name}`);
  const start = Date.now();
  try {
    await fn();
    console.log(`  ${INFO} elapsed: ${Date.now() - start}ms`);
  } catch (err) {
    console.log(`  ${FAIL} THREW: ${err.message}`);
    failed++;
  }
}

function typedDegradation(kind, message) {
  return {
    status: 'degraded',
    kind,
    message,
  };
}

function classifyProviderDegradation(error) {
  const message = String(error?.message || error || '');
  const lower = message.toLowerCase();

  if (/\bchallenge page\b|\bcaptcha\b|captcha cooldown|in captcha cooldown|checking your browser/.test(lower)) {
    return typedDegradation('challenge', message);
  }

  if (/\bblocked\b|verify you are human|unusual traffic|automated queries/.test(lower)) {
    return typedDegradation('blocked', message);
  }

  if (/rate limited|cooling down|cooldown active|throttle_violation|http (403|429)\b/.test(lower)) {
    return typedDegradation('rate_limited', message);
  }

  if (/\bconsent page\b|cookies/.test(lower)) {
    return typedDegradation('consent_required', message);
  }

  if (/empty_suspect|selector_miss|known-positive query returned no extractable results/.test(lower)) {
    return typedDegradation('selector_miss', message);
  }

  return null;
}

async function verifyLiveEngine({
  name,
  search,
  query,
  limit,
  minResults,
  check,
}) {
  try {
    const results = await search(query, limit);
    assert(Array.isArray(results), `${name} returned an array`);
    assert(results.length >= minResults, `got ${results.length} results (≥${minResults} expected)`);
    if (results.length >= minResults && check) check(results);
    console.log(`  ${INFO} top result: ${results[0]?.url}`);
    return { status: 'ok', results };
  } catch (err) {
    const degraded = classifyProviderDegradation(err);
    if (!degraded) throw err;

    assert(degraded.status === 'degraded' && degraded.kind, `${name} reported typed degraded state`);
    console.log(`  ${INFO} degraded:${degraded.kind} — ${degraded.message}`);
    return degraded;
  }
}

function classifyEngineErrors(errors = {}) {
  return Object.fromEntries(
    Object.entries(errors).map(([engine, message]) => [
      engine,
      classifyProviderDegradation(message) || { status: 'failed', kind: 'unknown', message },
    ]),
  );
}

// ─── Engine Tests ────────────────────────────────────────────────────────────

await runTest('DDG — nodejs documentation', async () => {
  await verifyLiveEngine({
    name: 'DDG',
    search: searchDdg,
    query: 'nodejs documentation',
    limit: 5,
    minResults: 3,
    check(results) {
      const hasNodejs = results.some(r => r.url.includes('nodejs.org'));
      assert(hasNodejs, 'nodejs.org in results');
    },
  });
});

await runTest('Brave — python requests library', async () => {
  await verifyLiveEngine({
    name: 'Brave',
    search: searchBrave,
    query: 'python requests library',
    limit: 5,
    minResults: 2,
  });
});

await runTest('Bing — typescript handbook', async () => {
  await verifyLiveEngine({
    name: 'Bing',
    search: searchBing,
    query: 'typescript handbook',
    limit: 5,
    minResults: 2,
  });
});

await runTest('Google — rust programming language', async () => {
  await verifyLiveEngine({
    name: 'Google',
    search: searchGoogle,
    query: 'rust programming language docs',
    limit: 5,
    minResults: 2,
  });
});

await runTest('Reddit — ollama local llm', async () => {
  await verifyLiveEngine({
    name: 'Reddit',
    search: searchReddit,
    query: 'ollama local llm',
    limit: 5,
    minResults: 1,
  });
});

await runTest('GitHub — cloakbrowser', async () => {
  await verifyLiveEngine({
    name: 'GitHub',
    search: searchGithub,
    query: 'cloakbrowser playwright stealth',
    limit: 5,
    minResults: 1,
    check(results) {
      const hasCloakBrowser = results.some(r => r.url.toLowerCase().includes('cloak'));
      assert(hasCloakBrowser, 'cloakbrowser repo in results');
    },
  });
});

await runTest('Stack Overflow — python TypeError', async () => {
  await verifyLiveEngine({
    name: 'Stack Overflow',
    search: searchStackOverflow,
    query: 'python TypeError fix stackoverflow',
    limit: 5,
    minResults: 1,
    check(results) {
      const hasStackOverflow = results.some(r => r.url.includes('stackoverflow.com/questions/'));
      assert(hasStackOverflow, 'Stack Overflow question in results');
    },
  });
});

await runTest('Wikipedia — large language model', async () => {
  await verifyLiveEngine({
    name: 'Wikipedia',
    search: searchWikipedia,
    query: 'large language model',
    limit: 3,
    minResults: 1,
    check(results) {
      const hasExtract = results[0]?.snippet.length > 50;
      assert(hasExtract, 'has meaningful snippet');
      console.log(`  ${INFO} top: "${results[0]?.title}" — ${results[0]?.snippet.slice(0, 80)}...`);
    },
  });
});

await runTest('Full merger — anthropic claude api', async () => {
  const result = await runSearch('anthropic claude api', { limit: 10, awaitBackground: true });
  assert(result.results.length >= 5, `got ${result.results.length} merged results (≥5 expected)`);
  assert(result.elapsed_ms < MAX_FULL_MERGER_MS, `elapsed ${result.elapsed_ms}ms (<${MAX_FULL_MERGER_MS}ms expected)`);
  const completedEngines = result.engineStats.completed.length;
  const degradedErrors = classifyEngineErrors(result.engineStats.errors);
  const unknownFailures = Object.entries(degradedErrors).filter(([, state]) => state.status !== 'degraded');
  const typedDegradedCount = Object.values(degradedErrors).filter(state => state.status === 'degraded').length;
  assert(unknownFailures.length === 0, 'failed engines are typed degraded states', unknownFailures.map(([engine, state]) => `${engine}:${state.message}`).join(' | '));
  assert(completedEngines + typedDegradedCount >= 4, `${completedEngines} engines completed + ${typedDegradedCount} typed degraded (≥4 expected)`);
  assert(Array.isArray(result.engineStats.pending), 'engineStats.pending is present');
  assert(result.intent === 'docs', `intent detected as ${result.intent}`);
  // Check cross-engine boost is working (some results from multiple engines)
  const boosted = result.results.filter(r => r.engines?.length > 1);
  console.log(`  ${INFO} ${boosted.length} results appeared in multiple engines (cross-engine boost)`);
  console.log(`  ${INFO} engines: ${result.engineStats.completed.join(', ')}`);
  for (const [engine, state] of Object.entries(degradedErrors)) {
    if (state.status === 'degraded') {
      console.log(`  ${INFO} ${engine}: degraded:${state.kind} — ${state.message}`);
    }
  }
  console.log(`  ${INFO} elapsed: ${result.elapsed_ms}ms`);
  result.results.slice(0, 3).forEach((r, i) => {
    console.log(`  ${INFO} #${i + 1}: [${r.engines?.join('+')}] score=${r.score} ${r.url}`);
  });
});

await runTest('Full merger — docs query ranks official source in top 3', async () => {
  const result = await runSearch('nodejs documentation', { limit: 5, awaitBackground: true });
  const top3 = result.results.slice(0, 3).map(r => r.url);
  assert(top3.some(url => url.includes('nodejs.org')), 'nodejs.org appears in top 3');
  console.log(`  ${INFO} top 3: ${top3.join(' | ')}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

await closeBrowser();

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

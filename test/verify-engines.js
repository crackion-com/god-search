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
import { runSearch } from '../src/merger.js';
import { closeBrowser } from '../src/browser.js';

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';
const INFO = '\x1b[33m•\x1b[0m';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
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

// ─── Engine Tests ────────────────────────────────────────────────────────────

await runTest('DDG — nodejs documentation', async () => {
  const results = await searchDdg('nodejs documentation', 5);
  assert(results.length >= 3, `got ${results.length} results (≥3 expected)`);
  const hasNodejs = results.some(r => r.url.includes('nodejs.org'));
  assert(hasNodejs, 'nodejs.org in results');
  console.log(`  ${INFO} top result: ${results[0]?.url}`);
});

await runTest('Brave — python requests library', async () => {
  try {
    const results = await searchBrave('python requests library', 5);
    assert(results.length >= 2, `got ${results.length} results (≥2 expected)`);
    console.log(`  ${INFO} top result: ${results[0]?.url}`);
  } catch (err) {
    if (String(err.message || err).includes('challenge page')) {
      console.log(`  ${INFO} skipped due to Brave challenge: ${err.message}`);
      return;
    }
    throw err;
  }
});

await runTest('Bing — typescript handbook', async () => {
  const results = await searchBing('typescript handbook', 5);
  assert(results.length >= 2, `got ${results.length} results (≥2 expected)`);
  console.log(`  ${INFO} top result: ${results[0]?.url}`);
});

await runTest('Google — rust programming language', async () => {
  const results = await searchGoogle('rust programming language docs', 5);
  assert(results.length >= 2, `got ${results.length} results (≥2 expected)`);
  console.log(`  ${INFO} top result: ${results[0]?.url}`);
});

await runTest('Reddit — ollama local llm', async () => {
  const results = await searchReddit('ollama local llm', 5);
  assert(results.length >= 1, `got ${results.length} results (≥1 expected)`);
  console.log(`  ${INFO} top result: ${results[0]?.url}`);
});

await runTest('GitHub — cloakbrowser', async () => {
  const results = await searchGithub('cloakbrowser playwright stealth', 5);
  assert(results.length >= 1, `got ${results.length} results (≥1 expected)`);
  const hasCloakBrowser = results.some(r => r.url.toLowerCase().includes('cloak'));
  assert(hasCloakBrowser, 'cloakbrowser repo in results');
  console.log(`  ${INFO} top result: ${results[0]?.url}`);
});

await runTest('Wikipedia — large language model', async () => {
  const results = await searchWikipedia('large language model', 3);
  assert(results.length >= 1, `got ${results.length} results (≥1 expected)`);
  const hasExtract = results[0]?.snippet.length > 50;
  assert(hasExtract, 'has meaningful snippet');
  console.log(`  ${INFO} top: "${results[0]?.title}" — ${results[0]?.snippet.slice(0, 80)}...`);
});

await runTest('Full merger — anthropic claude api', async () => {
  const result = await runSearch('anthropic claude api', { limit: 10, awaitBackground: true });
  assert(result.results.length >= 5, `got ${result.results.length} merged results (≥5 expected)`);
  assert(result.elapsed_ms < 8000, `elapsed ${result.elapsed_ms}ms (<8000ms expected)`);
  const completedEngines = result.engineStats.completed.length;
  assert(completedEngines >= 4, `${completedEngines} engines completed (≥4 expected)`);
  assert(Array.isArray(result.engineStats.pending), 'engineStats.pending is present');
  assert(result.intent === 'docs', `intent detected as ${result.intent}`);
  // Check cross-engine boost is working (some results from multiple engines)
  const boosted = result.results.filter(r => r.engines?.length > 1);
  console.log(`  ${INFO} ${boosted.length} results appeared in multiple engines (cross-engine boost)`);
  console.log(`  ${INFO} engines: ${result.engineStats.completed.join(', ')}`);
  if (result.engineStats.failed.length) {
    console.log(`  ${INFO} failed: ${result.engineStats.failed.join(', ')}`);
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

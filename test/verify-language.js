/**
 * Language and locale-routing contract tests.
 *
 * Run:
 *   node test/verify-language.js
 */

import {
  buildLanguageContext,
  detectLanguage,
  keywordTokens,
} from '../src/language.js';
import { buildBingSearchUrl } from '../src/engines/bing.js';
import { buildDdgSearchUrl } from '../src/engines/ddg.js';
import { buildGoogleSearchUrl } from '../src/engines/google.js';
import { buildWikipediaSearchUrl } from '../src/engines/wikipedia.js';
import { mergeEngineResults } from '../src/merger.js';

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

async function runTest(name, fn) {
  console.log(`\n${INFO} ${name}`);
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  }
}

await runTest('detects common query languages without external services', () => {
  assert(detectLanguage('documentación de python pathlib').language === 'es', 'detects Spanish');
  assert(detectLanguage('documentation python pathlib avec exemples').language === 'fr', 'detects French');
  assert(detectLanguage('was ist retrieval augmented generation').language === 'de', 'detects German');
  assert(detectLanguage('ما هو تعلم الآلة').language === 'ar', 'detects Arabic');
  assert(detectLanguage('React useEffect ドキュメント').language === 'ja', 'detects Japanese');
  assert(detectLanguage('что такое vector database').language === 'ru', 'detects Cyrillic/Russian');
});

await runTest('builds conservative engine locale hints', () => {
  const es = buildLanguageContext('documentación de python pathlib');
  const google = buildGoogleSearchUrl('documentación de python pathlib', 10, es);
  const bing = buildBingSearchUrl('documentación de python pathlib', 10, es);
  const ddg = buildDdgSearchUrl('documentación de python pathlib', 10, es);
  const wiki = buildWikipediaSearchUrl('qué es Australia', 5, es);

  assert(google.searchParams.get('hl') === 'es', 'Google hl follows detected language', google.toString());
  assert(google.searchParams.get('lr') === 'lang_es', 'Google lr follows detected language', google.toString());
  assert(bing.searchParams.get('setLang') === 'es', 'Bing setLang follows detected language', bing.toString());
  assert(bing.searchParams.get('mkt') === 'es-ES', 'Bing mkt follows detected market', bing.toString());
  assert(!bing.searchParams.has('cc'), 'Bing omits cc when mkt is set', bing.toString());
  assert(ddg.searchParams.get('kl') === 'es-es', 'DDG kl follows conservative region map', ddg.toString());
  assert(wiki.hostname === 'es.wikipedia.org', 'Wikipedia API host follows supported language', wiki.toString());
});

await runTest('tokenizes Unicode and records language ranking evidence', () => {
  const context = buildLanguageContext('ما هو تعلم الآلة');
  const tokens = keywordTokens('ما هو تعلم الآلة', context);
  assert(tokens.includes('تعلم') && tokens.includes('الآلة'), 'keeps Arabic keyword tokens', tokens.join(','));

  const merged = mergeEngineResults(new Map([
    ['ddg', [
      { title: 'تعلم الآلة', url: 'https://ar.wikipedia.org/wiki/تعلم_الآلة', snippet: 'تعلم الآلة هو مجال من مجالات الذكاء الاصطناعي' },
      { title: 'Machine learning', url: 'https://en.wikipedia.org/wiki/Machine_learning', snippet: 'Machine learning is a field of artificial intelligence' },
    ]],
  ]), 'ما هو تعلم الآلة', 2, 'factual', context);

  assert(merged[0]?.url.includes('ar.wikipedia.org'), 'same-language result ranks first', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.language_bonus > 0, 'records language bonus evidence');
});

console.log(`\nResults: ${failed ? FAIL : PASS} ${passed} passed   ${failed} failed`);
if (failed) process.exit(1);

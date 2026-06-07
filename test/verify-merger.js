/**
 * Offline merger/routing contract tests.
 *
 * Run:
 *   node test/verify-merger.js
 */

import { mergeEngineResults, planSearchEngines } from '../src/merger.js';

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

function disabledBrave() {
  return { enableBraveByDefault: false };
}

function result(title, url, snippet = 'useful snippet', extra = {}) {
  return { title, url, snippet, ...extra };
}

await runTest('plans intent-specific default engine order', () => {
  let plan = planSearchEngines('nodejs documentation', { searchConfig: disabledBrave() });
  assert(plan.intent === 'docs', `docs intent detected`, `got ${plan.intent}`);
  assert(plan.attempted.slice(0, 4).join(',') === 'official,ddg,google,bing', 'docs starts with official/ddg/google/bing', plan.attempted.join(','));
  assert(!plan.attempted.includes('brave'), 'Brave is excluded by default when disabled');

  plan = planSearchEngines('github cloakbrowser implementation', { searchConfig: disabledBrave() });
  assert(plan.intent === 'code', `code intent detected`, `got ${plan.intent}`);
  assert(plan.attempted[0] === 'github', 'code starts with GitHub');
  assert(plan.attempted[1] === 'stackoverflow', 'code uses Stack Overflow after GitHub');

  plan = planSearchEngines('python TypeError fix', { searchConfig: disabledBrave() });
  assert(plan.intent === 'code', `debug/error intent detected`, `got ${plan.intent}`);
  assert(plan.attempted.slice(0, 2).join(',') === 'github,stackoverflow', 'debug/error queries include Stack Overflow early', plan.attempted.join(','));

  plan = planSearchEngines('vite plugin npm package', { searchConfig: disabledBrave() });
  assert(plan.intent === 'code', `npm package intent detected`, `got ${plan.intent}`);
  assert(plan.attempted.slice(0, 3).join(',') === 'github,stackoverflow,npm', 'package queries include npm early', plan.attempted.join(','));

  plan = planSearchEngines('best local llm reddit discussion', { searchConfig: disabledBrave() });
  assert(plan.intent === 'discussion', `discussion intent detected`, `got ${plan.intent}`);
  assert(plan.attempted[0] === 'reddit', 'discussion starts with Reddit');

  plan = planSearchEngines('show hn vector database', { searchConfig: disabledBrave() });
  assert(plan.intent === 'discussion', `HN discussion intent detected`, `got ${plan.intent}`);
  assert(plan.attempted.slice(0, 2).join(',') === 'reddit,hackernews', 'HN discussion uses Hacker News early', plan.attempted.join(','));

  plan = planSearchEngines('what is a large language model', { searchConfig: disabledBrave() });
  assert(plan.intent === 'factual', `factual intent detected`, `got ${plan.intent}`);
  assert(plan.attempted.slice(0, 2).join(',') === 'official,wikipedia', 'factual starts with official/Wikipedia', plan.attempted.join(','));
});

await runTest('explicit engine filters preserve intent order and include Brave', () => {
  const plan = planSearchEngines('nodejs documentation', {
    engines: ['brave', 'stackoverflow', 'github', 'google'],
    searchConfig: disabledBrave(),
  });

  assert(plan.intent === 'docs', 'detects docs intent for explicit filter');
  assert(plan.attempted.join(',') === 'google,brave,github,stackoverflow', 'explicit engines are filtered and sorted by docs intent', plan.attempted.join(','));
  assert(plan.attempted.includes('brave'), 'explicit Brave is allowed even when disabled by default');
});

await runTest('merge deduplicates URLs and records cross-engine evidence', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Node Docs', 'https://nodejs.org/en/docs?utm_source=x', 'short'),
      result('Example A', 'https://example.com/a', 'A'),
    ]],
    ['google', [
      result('Node Docs', 'https://nodejs.org/en/docs', 'longer official documentation snippet'),
      result('Example B', 'https://example.com/b', 'B'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'nodejs documentation', 10, 'docs');
  const node = merged.find(item => item.url.includes('nodejs.org/en/docs'));
  assert(node, 'keeps merged Node docs result');
  assert(node?.engines.includes('ddg') && node?.engines.includes('google'), 'records both source engines');
  assert(node?.snippet === 'longer official documentation snippet', 'keeps longest snippet on duplicate URL');
});

await runTest('merge enforces domain diversity and stable ranks', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Example 1', 'https://example.com/one', 'alpha one'),
      result('Example 2', 'https://example.com/two', 'alpha two'),
      result('Example 3', 'https://example.com/three', 'alpha three'),
      result('Other', 'https://other.test/four', 'alpha four'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha', 10, 'general');
  const exampleCount = merged.filter(item => item.url.includes('example.com')).length;
  assert(exampleCount === 2, 'keeps at most two results per domain', `kept ${exampleCount}`);
  assert(merged.every((item, index) => item.rank === index + 1), 'assigns stable 1-based ranks');
});

await runTest('merge preserves per-engine source ranks on deduplicated results', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Node Docs', 'https://nodejs.org/en/docs?utm_source=x', 'short docs', { sourceRank: 2 }),
    ]],
    ['google', [
      result('Node Docs', 'https://nodejs.org/en/docs', 'longer official documentation snippet', { sourceRank: 5 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'nodejs documentation', 10, 'docs');
  const node = merged.find(item => item.url.includes('nodejs.org/en/docs'));
  assert(node?.sourceRanks?.ddg === 2, 'preserves DDG native rank', JSON.stringify(node?.sourceRanks));
  assert(node?.sourceRanks?.google === 5, 'preserves Google native rank', JSON.stringify(node?.sourceRanks));
  assert(node?.evidence?.source_ranks?.ddg === 2, 'exposes native ranks in evidence');
});

await runTest('merge does not double-count generic SERPs as independent evidence families', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 1 }),
    ]],
    ['bing', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 2 }),
    ]],
    ['google', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 3 }),
    ]],
    ['brave', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 4 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha reference', 10, 'general');
  assert(merged[0]?.engines.length === 4, 'preserves all source engine names');
  assert(merged[0]?.evidence?.cross_engine_count === 4, 'preserves raw cross-engine count');
  assert(merged[0]?.evidence?.evidence_family_count === 1, 'generic SERPs count as one evidence family');
  assert(merged[0]?.evidence?.evidence_families?.[0] === 'web_serp', 'records web SERP family');
  assert(merged[0]?.evidence?.cross_engine_bonus === 0, 'generic SERP duplicates do not get multi-family boost');
  assert(merged[0]?.evidence?.source_reliability_bonus <= 1.01, 'generic SERP reliability is not added four times');
});

await runTest('merge still boosts corroboration from distinct evidence families', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 1 }),
    ]],
    ['wikipedia', [
      result('Alpha Reference', 'https://example.org/alpha', 'alpha reference', { sourceRank: 1 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha reference', 10, 'general');
  assert(merged[0]?.evidence?.evidence_family_count === 2, 'distinct sources count as two evidence families');
  assert(merged[0]?.evidence?.cross_engine_bonus === 4, 'distinct source families retain cross-engine boost');
});

await runTest('code intent uses capped GitHub provider score as ranking evidence', () => {
  const engineMap = new Map([
    ['github', [
      result('CloakBrowser clone', 'https://github.com/clone/CloakBrowser', 'cloakbrowser implementation', { sourceRank: 1, score: 60 }),
      result('CloakBrowser canonical', 'https://github.com/CloakHQ/CloakBrowser', 'cloakbrowser implementation', { sourceRank: 2, score: 130 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'github cloakbrowser implementation', 10, 'code');
  assert(merged[0]?.url === 'https://github.com/CloakHQ/CloakBrowser', 'higher GitHub provider score breaks exact-name tie');
  assert(merged[0]?.evidence?.source_provided_bonus > merged[1]?.evidence?.source_provided_bonus, 'records capped provider score evidence');
});

await runTest('merge adds a generic native-rank bonus before final ranking', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha Reference', 'https://a.test/item', 'alpha shared snippet', { sourceRank: 10 }),
      result('Alpha Reference', 'https://b.test/item', 'alpha shared snippet', { sourceRank: 1 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha', 10, 'general');
  assert(merged[0]?.url === 'https://b.test/item', 'higher native rank wins when lexical score ties', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.native_rank_bonus > merged[1]?.evidence?.native_rank_bonus, 'native rank bonus is recorded');
});

await runTest('merge applies intent-aware domain caps', () => {
  const githubRows = Array.from({ length: 6 }, (_, index) =>
    result(`GitHub Repo ${index + 1}`, `https://github.com/example/repo-${index + 1}`, 'alpha implementation source code')
  );
  const redditRows = Array.from({ length: 6 }, (_, index) =>
    result(`Reddit Thread ${index + 1}`, `https://www.reddit.com/r/search/comments/${index + 1}/alpha`, 'alpha community discussion')
  );

  const codeMerged = mergeEngineResults(new Map([['github', githubRows]]), 'alpha github implementation', 10, 'code');
  const stackOverflowRows = Array.from({ length: 6 }, (_, index) =>
    result(`Stack Overflow Question ${index + 1}`, `https://stackoverflow.com/questions/${index + 1}/alpha`, 'alpha exception accepted answer')
  );
  const stackOverflowMerged = mergeEngineResults(new Map([['stackoverflow', stackOverflowRows]]), 'alpha exception fix', 10, 'code');
  const npmRows = Array.from({ length: 5 }, (_, index) =>
    result(`npm package ${index + 1}`, `https://www.npmjs.com/package/alpha-${index + 1}`, 'alpha npm package')
  );
  const npmMerged = mergeEngineResults(new Map([['npm', npmRows]]), 'alpha npm package', 10, 'code');
  const discussionMerged = mergeEngineResults(new Map([['reddit', redditRows]]), 'alpha reddit discussion', 10, 'discussion');
  const generalMerged = mergeEngineResults(new Map([['github', githubRows]]), 'alpha', 10, 'general');

  assert(codeMerged.filter(item => item.evidence.domain === 'github.com').length === 5, 'code intent allows five GitHub results');
  assert(stackOverflowMerged.filter(item => item.evidence.domain === 'stackoverflow.com').length === 4, 'code intent allows four Stack Overflow results');
  assert(npmMerged.filter(item => item.evidence.domain === 'npmjs.com').length === 4, 'code intent allows four npm results');
  assert(discussionMerged.filter(item => item.evidence.domain === 'reddit.com').length === 5, 'discussion intent allows five Reddit results');
  assert(generalMerged.filter(item => item.evidence.domain === 'github.com').length === 2, 'general intent keeps default cap');
});

await runTest('merge applies title and snippet match evidence', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Unrelated', 'https://weak.test/item', 'generic snippet', { sourceRank: 1 }),
      result('Alpha beta gamma', 'https://strong.test/item', 'alpha beta gamma reference', { sourceRank: 5 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha beta gamma', 10, 'general');
  assert(merged[0]?.url === 'https://strong.test/item', 'strong title/snippet match outranks weak native rank', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.text_match_bonus > 0, 'records positive text match evidence');
});

await runTest('docs intent prefers official-domain siblings over source hosts', () => {
  const engineMap = new Map([
    ['ddg', [
      result('useEffect', 'https://react.dev/reference/react/useEffect', 'React useEffect API reference'),
      result('Effects', 'https://react.dev/learn/synchronizing-with-effects', 'Synchronizing with effects'),
      result('React docs repo', 'https://github.com/reactjs/react.dev', 'React docs repository'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'react useeffect api reference', 10, 'docs');
  const learnIndex = merged.findIndex(item => item.url.includes('react.dev/learn'));
  const githubIndex = merged.findIndex(item => item.url.includes('github.com/reactjs'));
  assert(learnIndex !== -1 && githubIndex !== -1 && learnIndex < githubIndex, 'official-domain sibling beats GitHub repo for docs intent', merged.map(item => item.url).join(','));
  assert(merged[learnIndex]?.evidence?.official_domain_bonus > 0, 'records official-domain sibling evidence');
});

await runTest('docs intent prefers known official docs over generic docs hosts and home pages', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Pathlib Tutorial', 'https://docs.kanaries.net/topics/Python/python-pathlib', 'Python pathlib docs tutorial'),
      result('pathlib - Object-oriented filesystem paths', 'https://docs.python.org/3/library/pathlib.html', 'Python pathlib docs official library reference'),
      result('Node.js', 'https://nodejs.org/', 'Node.js homepage'),
      result('Node.js API documentation', 'https://nodejs.org/api/', 'Node.js documentation API reference'),
      result('Node.js complete API documentation', 'https://nodejs.org/api/all.html', 'Node.js documentation complete API reference'),
    ]],
  ]);

  const pathlib = mergeEngineResults(engineMap, 'python pathlib docs', 10, 'docs');
  const pythonIndex = pathlib.findIndex(item => item.url.includes('docs.python.org/3/library/pathlib.html'));
  const genericDocsIndex = pathlib.findIndex(item => item.url.includes('docs.kanaries.net'));
  assert(pythonIndex !== -1 && genericDocsIndex !== -1 && pythonIndex < genericDocsIndex, 'official Python docs outrank generic docs host', pathlib.map(item => item.url).join(','));

  const node = mergeEngineResults(engineMap, 'nodejs documentation', 10, 'docs');
  const apiUrls = node.slice(0, 3).map(item => item.url);
  assert(apiUrls.includes('https://nodejs.org/api/'), 'Node API docs stay in top 3');
  assert(apiUrls.includes('https://nodejs.org/api/all.html'), 'Node complete API docs stay in top 3');
  assert(!apiUrls.includes('https://nodejs.org/'), 'Node homepage does not crowd out API docs');
});

await runTest('docs intent allows three results from an official domain family', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha docs one', 'https://docs.example.org/one', 'alpha docs one'),
      result('Alpha docs two', 'https://www.example.org/docs/two', 'alpha docs two'),
      result('Alpha wiki three', 'https://wiki.example.org/three', 'alpha wiki three'),
      result('Alpha other', 'https://other.test/four', 'alpha other'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha docs', 10, 'docs');
  assert(merged.filter(item => item.evidence.domain === 'example.org').length === 3, 'docs intent keeps three results from official domain family');
});

await runTest('general intent does not let plain GitHub guide pages dominate official docs', () => {
  const engineMap = new Map([
    ['ddg', [
      result('GitHub rebase guide', 'https://github.com/git-guides/git-rebase', 'GitHub guide'),
      result('git rebase docs', 'https://git-scm.com/docs/git-rebase', 'Git rebase reference'),
      result('Rewriting History', 'https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History', 'Interactive rebase guide'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'git rebase interactive guide', 10, 'general');
  assert(merged[0]?.url === 'https://git-scm.com/docs/git-rebase', 'official docs outrank plain GitHub guide for general intent', merged.map(item => item.url).join(','));
});

await runTest('merge canonicalizes common duplicate URL variants', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha Docs', 'http://www.example.org/docs/index.html?utm_source=x&b=2&a=1#section', 'short alpha docs', { sourceRank: 3 }),
    ]],
    ['google', [
      result('Alpha Docs', 'https://example.org/docs/?a=1&b=2', 'longer alpha docs canonical snippet', { sourceRank: 1 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha docs', 10, 'docs');
  assert(merged.length === 1, 'canonical URL variants are deduplicated', merged.map(item => item.url).join(','));
  assert(merged[0]?.engines.includes('ddg') && merged[0]?.engines.includes('google'), 'deduped canonical keeps both engines');
});

await runTest('freshness evidence boosts visible recent results for freshness queries', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Alpha release notes 2023', 'https://alpha.test/releases/2023', 'Updated January 2, 2023'),
      result('Alpha release notes 2026', 'https://alpha.test/releases/2026', 'Updated March 2, 2026'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'latest alpha release notes 2026', 10, 'general');
  assert(merged[0]?.url === 'https://alpha.test/releases/2026', 'newest visible date wins freshness query', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.freshness_bonus > merged[1]?.evidence?.freshness_bonus, 'records freshness evidence');
});

await runTest('source reliability is intent-aware but generic', () => {
  const discussionRows = new Map([
    ['github', [
      result('Alpha discussion', 'https://github.com/example/alpha/discussions/1', 'alpha discussion thread', { sourceRank: 1 }),
    ]],
    ['reddit', [
      result('Alpha discussion', 'https://www.reddit.com/r/example/comments/abc/alpha_discussion/', 'alpha community discussion', { sourceRank: 3 }),
    ]],
  ]);

  const merged = mergeEngineResults(discussionRows, 'alpha reddit discussion', 10, 'discussion');
  assert(merged[0]?.evidence?.domain === 'reddit.com', 'discussion intent prefers discussion source reliability', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.source_reliability_bonus > merged[1]?.evidence?.source_reliability_bonus, 'records source reliability evidence');
});

await runTest('discussion intent locks settled results to discussion verticals when available', () => {
  const engineMap = new Map([
    ['reddit', [
      result('Alpha subreddit', 'https://www.reddit.com/r/alpha', 'alpha community discussion', { sourceRank: 1 }),
    ]],
    ['ddg', [
      result('Alpha SEO guide', 'https://seo.example.com/alpha', 'alpha reddit discussion guide', { sourceRank: 1 }),
      result('Alpha Reddit thread', 'https://www.reddit.com/r/alpha/comments/abc/thread/', 'alpha discussion thread', { sourceRank: 2 }),
    ]],
    ['bing', [
      result('Alpha forum mirror', 'https://www.redditmedia.com/r/alpha/comments/def/thread/', 'alpha discussion mirror', { sourceRank: 1 }),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'alpha reddit discussion', 10, 'discussion');
  assert(!merged.some(item => item.url.includes('seo.example.com')), 'filters non-discussion web SERP result after Reddit evidence exists', merged.map(item => item.url).join(','));
  assert(merged.some(item => item.url.includes('reddit.com/r/alpha')), 'keeps direct Reddit vertical result');
  assert(merged.some(item => item.url.includes('redditmedia.com')), 'keeps web-discovered Reddit media discussion result');
});

await runTest('discussion lock does not affect general intent or fallback-only discussion results', () => {
  const webOnly = new Map([
    ['ddg', [
      result('Alpha SEO guide', 'https://seo.example.com/alpha', 'alpha reddit discussion guide', { sourceRank: 1 }),
    ]],
  ]);
  const withVertical = new Map([
    ['reddit', [
      result('Alpha subreddit', 'https://www.reddit.com/r/alpha', 'alpha community discussion', { sourceRank: 1 }),
    ]],
    ['ddg', [
      result('Alpha SEO guide', 'https://seo.example.com/alpha', 'alpha reddit discussion guide', { sourceRank: 1 }),
    ]],
  ]);

  const fallbackOnly = mergeEngineResults(webOnly, 'alpha reddit discussion', 10, 'discussion');
  const general = mergeEngineResults(withVertical, 'alpha reddit discussion', 10, 'general');
  assert(fallbackOnly.some(item => item.url.includes('seo.example.com')), 'keeps web result when no discussion vertical exists');
  assert(general.some(item => item.url.includes('seo.example.com')), 'keeps web result outside discussion intent');
});

await runTest('factual intent prefers primary authority over generic Wikipedia fallback', () => {
  const engineMap = new Map([
    ['wikipedia', [
      result('Artemis program', 'https://en.wikipedia.org/wiki/Artemis_program', 'NASA Artemis overview'),
    ]],
    ['ddg', [
      result('Artemis', 'https://www.nasa.gov/humans-in-space/artemis/', 'NASA Artemis program overview'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'nasa artemis program overview', 10, 'factual');
  assert(merged[0]?.evidence?.domain === 'nasa.gov', 'NASA primary authority outranks Wikipedia fallback', merged.map(item => item.url).join(','));
  assert(merged[0]?.evidence?.authority_bonus > 0, 'records factual authority evidence');
});

await runTest('standards queries prefer standards authorities', () => {
  const engineMap = new Map([
    ['ddg', [
      result('Robots.txt overview', 'https://www.robotstxt.org/robotstxt.html', 'Robots exclusion protocol guide'),
      result('RFC 9309', 'https://www.rfc-editor.org/rfc/rfc9309', 'RFC 9309 Robots Exclusion Protocol'),
      result('Datatracker RFC 9309', 'https://datatracker.ietf.org/doc/html/rfc9309', 'RFC 9309 standard'),
    ]],
  ]);

  const merged = mergeEngineResults(engineMap, 'robots.txt standard', 10, 'general');
  assert(
    merged[0]?.url.includes('rfc9309') || merged[0]?.url.includes('datatracker.ietf.org'),
    'standards authority outranks weaker guide pages',
    merged.map(item => item.url).join(',')
  );
  assert(merged[0]?.evidence?.authority_bonus > 0, 'records standards authority evidence');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

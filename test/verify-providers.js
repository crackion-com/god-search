/**
 * Offline provider contract tests.
 *
 * Run:
 *   node test/verify-providers.js
 */

import { SEARCH_CONFIG, REDDIT_CONFIG } from '../src/config.js';
import {
  __resetForTests as resetGithub,
  normalizeGithubQuery,
  searchGithub,
} from '../src/engines/github.js';
import {
  __resetForTests as resetReddit,
  searchReddit,
} from '../src/engines/reddit.js';
import {
  __resetForTests as resetWikipedia,
  searchWikipedia,
} from '../src/engines/wikipedia.js';
import {
  __resetForTests as resetStackOverflow,
  searchStackOverflow,
} from '../src/engines/stackoverflow.js';
import {
  __resetForTests as resetHackerNews,
  searchHackerNews,
} from '../src/engines/hackernews.js';
import {
  __resetForTests as resetNpm,
  searchNpm,
} from '../src/engines/npm.js';
import {
  __resetForTests as resetBrave,
  searchBrave,
} from '../src/engines/brave.js';
import { searchOfficial } from '../src/engines/official.js';

const PASS = '\x1b[32mOK\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[33mINFO\x1b[0m';

let passed = 0;
let failed = 0;

const originalFetch = globalThis.fetch;
const originalSearchConfig = { ...SEARCH_CONFIG };
const originalRedditConfig = { ...REDDIT_CONFIG };

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
  resetAll();
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.log(`  ${FAIL} threw: ${err?.stack || err?.message || err}`);
  } finally {
    resetAll();
  }
}

function resetAll() {
  resetGithub();
  resetReddit();
  resetWikipedia();
  resetStackOverflow();
  resetHackerNews();
  resetNpm();
  resetBrave();
  Object.assign(SEARCH_CONFIG, originalSearchConfig);
  Object.assign(REDDIT_CONFIG, originalRedditConfig);
  globalThis.fetch = originalFetch;
}

function installFetchMock(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length - 1);
  };
  return calls;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function expectThrows(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'did not throw');
    return null;
  } catch (err) {
    assert(pattern.test(err?.message || String(err)), label, err?.message || String(err));
    return err;
  }
}

function redditChildren(posts) {
  return { data: { children: posts.map(data => ({ data })) } };
}

await runTest('GitHub maps repository API results and request params', async () => {
  const calls = installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'owner/project',
        html_url: 'https://github.com/owner/project',
        description: 'Useful project',
        topics: ['search', 'agent'],
        stargazers_count: 1234,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('agent search github repo', 5);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://api.github.com/search/repositories', 'uses GitHub repository search endpoint');
  assert(requested.searchParams.get('q') === 'agent search in:name,description,readme', 'sets normalized q parameter');
  assert(requested.searchParams.get('per_page') === '10', 'sets per_page to limit + 5');
  assert(requested.searchParams.get('sort') === 'best_match', 'sets best_match sort');
  assert(calls[0].options.headers.Accept === 'application/vnd.github.v3+json', 'sets GitHub Accept header');
  assert(results[0]?.engine === 'github', 'maps engine field');
  assert(results[0]?.domain === 'github.com', 'maps domain field');
});

await runTest('GitHub query normalization removes search intent filler', async () => {
  assert(
    normalizeGithubQuery('playwright stealth implementation github example') === 'playwright stealth',
    'removes GitHub/search-intent filler terms',
  );
  assert(
    normalizeGithubQuery('sqlite node bindings github') === 'sqlite node bindings',
    'keeps meaningful repository terms',
  );
});

await runTest('GitHub emits web search fallback for repository-seeking queries', async () => {
  const calls = installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'owner/cloakbrowser',
        html_url: 'https://github.com/owner/cloakbrowser',
        description: 'CloakBrowser implementation',
        topics: [],
        stargazers_count: 5,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('github cloakbrowser implementation', 5);
  const requested = new URL(calls[0].url);
  assert(requested.searchParams.get('q') === 'cloakbrowser in:name,description,readme', 'uses normalized GitHub API query');
  assert(results.some(result => result.url === 'https://github.com/search?q=cloakbrowser'), 'adds GitHub web search fallback');
  assert(results.findIndex(result => result.url === 'https://github.com/search?q=cloakbrowser') > 0, 'keeps GitHub web search fallback below real repositories');
});

await runTest('GitHub public mode skips low-value resource queries before network', async () => {
  const calls = installFetchMock(() => jsonResponse({ items: [] }));

  const results = await searchGithub('nodejs documentation', 3);
  assert(results.length === 0, 'returns no GitHub results for docs-shaped public query');
  assert(calls.length === 0, 'does not spend public GitHub request on docs-shaped query');

  const generalResults = await searchGithub('markdown table syntax', 3);
  assert(generalResults.length === 0, 'returns no GitHub results for general non-repository query');
  assert(calls.length === 0, 'does not spend public GitHub request on general non-repository query');

  const implementationResults = await searchGithub('playwright stealth implementation', 3);
  assert(implementationResults.length === 0, 'returns no GitHub results for implementation query without explicit repository signal');
  assert(calls.length === 0, 'does not spend public GitHub request on implementation query without explicit repository signal');
});

await runTest('GitHub ranking boosts exact repo names and separator-equivalent phrases', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'popular/godot-search',
        name: 'godot-search',
        html_url: 'https://github.com/popular/godot-search',
        description: 'Popular game search project',
        topics: [],
        stargazers_count: 250000,
        fork: false,
      },
      {
        full_name: 'acme/god-search',
        name: 'god-search',
        html_url: 'https://github.com/acme/god-search',
        description: 'God search engine',
        topics: [],
        stargazers_count: 3,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('github god_search repo', 5);
  assert(results[0]?.url === 'https://github.com/acme/god-search', 'separator-equivalent exact repo name outranks high-star partial match');
});

await runTest('GitHub ranking prefers exact repo name over manager/list/rank noise', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'CloakHQ/CloakBrowser-Manager',
        owner: { type: 'Organization' },
        name: 'CloakBrowser-Manager',
        html_url: 'https://github.com/CloakHQ/CloakBrowser-Manager',
        description: 'Web-based browser profile manager for CloakBrowser',
        topics: ['browser-automation'],
        stargazers_count: 50000,
        forks_count: 100,
        size: 1000,
        has_discussions: true,
        fork: false,
      },
      {
        full_name: 'OpenGithubs/github-weekly-rank',
        name: 'github-weekly-rank',
        html_url: 'https://github.com/OpenGithubs/github-weekly-rank',
        description: 'Weekly rank listing including CloakBrowser',
        topics: [],
        stargazers_count: 999999,
        fork: false,
      },
      {
        full_name: 'CloakHQ/CloakBrowser',
        owner: { type: 'Organization' },
        name: 'CloakBrowser',
        html_url: 'https://github.com/CloakHQ/CloakBrowser',
        description: 'Stealth Chromium that passes bot detection tests',
        topics: ['playwright', 'stealth-browser'],
        stargazers_count: 12,
        forks_count: 3,
        size: 1200,
        homepage: 'https://cloakbrowser.dev/',
        has_discussions: true,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('github cloakbrowser implementation', 5);
  assert(results[0]?.url === 'https://github.com/CloakHQ/CloakBrowser', 'exact repo name outranks manager/listing noise');
  assert(results.findIndex(result => result.url === 'https://github.com/search?q=cloakbrowser') > 0, 'fallback remains below exact repo result');
});

await runTest('GitHub ranking uses repo quality as an exact-name tiebreaker', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'tiny/CloakBrowser',
        owner: { type: 'User' },
        name: 'CloakBrowser',
        html_url: 'https://github.com/tiny/CloakBrowser',
        description: 'CloakBrowser GitHub download install source browser automation API free GitHub',
        topics: ['cloakbrowser-download'],
        stargazers_count: 1000,
        forks_count: 1,
        size: 8,
        fork: false,
      },
      {
        full_name: 'CloakHQ/CloakBrowser',
        owner: { type: 'Organization' },
        name: 'CloakBrowser',
        html_url: 'https://github.com/CloakHQ/CloakBrowser',
        description: 'Stealth Chromium with source-level fingerprint patches',
        topics: ['playwright', 'stealth-browser'],
        stargazers_count: 10,
        forks_count: 1000,
        size: 5000,
        homepage: 'https://cloakbrowser.dev/',
        has_discussions: true,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('github cloakbrowser implementation', 5);
  assert(results[0]?.url === 'https://github.com/CloakHQ/CloakBrowser', 'mature exact-name repo outranks tiny exact-name keyword-stuffed repo');
});

await runTest('GitHub ranking boosts title and description phrase matches', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'microsoft/playwright',
        name: 'playwright',
        html_url: 'https://github.com/microsoft/playwright',
        description: 'Browser automation framework',
        topics: [],
        stargazers_count: 100000,
        fork: false,
      },
      {
        full_name: 'acme/stealth-kit',
        name: 'stealth-kit',
        html_url: 'https://github.com/acme/stealth-kit',
        description: 'Playwright stealth plugin for browser automation',
        topics: [],
        stargazers_count: 2,
        fork: false,
      },
    ],
  }));

  const results = await searchGithub('github playwright stealth repo', 5);
  assert(results[0]?.url === 'https://github.com/acme/stealth-kit', 'description phrase match outranks single-token high-star repository');
});

await runTest('GitHub uses token auth and bypasses local unauthenticated limiter', async () => {
  SEARCH_CONFIG.githubToken = 'github-test-token';
  const calls = installFetchMock(() => jsonResponse({
    items: [
      {
        full_name: 'owner/project',
        html_url: 'https://github.com/owner/project',
        description: 'Useful project',
        topics: [],
        stargazers_count: 1,
        fork: false,
      },
    ],
  }));

  for (let i = 0; i < 12; i++) {
    await searchGithub(`agent search ${i}`, 1);
  }

  assert(calls.length === 12, 'token mode bypasses local unauthenticated limiter');
  assert(calls[0].options.headers.Authorization === 'Bearer github-test-token', 'sets GitHub bearer token header');
});

await runTest('GitHub filters invalid and duplicate repository URLs', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      { full_name: 'bad/missing', description: 'missing url', stargazers_count: 0 },
      { full_name: 'owner/project', html_url: 'https://github.com/owner/project', description: 'one', stargazers_count: 1 },
      { full_name: 'owner/project-copy', html_url: 'https://github.com/owner/project', description: 'dup', stargazers_count: 2 },
    ],
  }));

  const results = await searchGithub('project github repo', 5);
  const repoResults = results.filter(item => item.url === 'https://github.com/owner/project');
  assert(repoResults.length === 1, 'keeps only one unique valid repository URL', `got ${repoResults.length}`);
});

await runTest('GitHub throws on rate limit and malformed shapes', async () => {
  installFetchMock(() => jsonResponse({ message: 'limit' }, { status: 403 }));
  await expectThrows(() => searchGithub('x github repo', 1), /rate limited \(403\)/, 'throws clear 403 rate-limit error');

  resetGithub();
  installFetchMock(() => jsonResponse({ nope: [] }));
  await expectThrows(() => searchGithub('x github repo', 1), /unexpected response shape/, 'throws on malformed response');
});

await runTest('GitHub local limiter blocks the 11th request', async () => {
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ items: [] });
  });

  for (let i = 0; i < 10; i += 1) await searchGithub(`query ${i} github repo`, 1);
  await expectThrows(() => searchGithub('query 11 github repo', 1), /GitHub rate limit/, 'throws local rate-limit error');
  assert(fetchCalls === 10, 'does not fetch after local limiter opens', `fetch calls ${fetchCalls}`);
});

await runTest('Stack Overflow maps public API questions and request params', async () => {
  const calls = installFetchMock(() => jsonResponse({
    items: [
      {
        question_id: 101,
        title: 'How to fix TypeError in Python?',
        link: 'https://stackoverflow.com/questions/101/how-to-fix-typeerror-in-python',
        tags: ['python', 'typeerror'],
        score: 42,
        answer_count: 3,
        is_answered: true,
        accepted_answer_id: 202,
      },
    ],
  }));

  const results = await searchStackOverflow('python TypeError fix stackoverflow', 5);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://api.stackexchange.com/2.3/search/advanced', 'uses Stack Exchange advanced search endpoint');
  assert(requested.searchParams.get('site') === 'stackoverflow', 'sets Stack Overflow site');
  assert(requested.searchParams.get('sort') === 'relevance', 'sets relevance sort');
  assert(requested.searchParams.get('q') === 'python TypeError fix stackoverflow', 'sets q parameter');
  assert(requested.searchParams.get('pagesize') === '10', 'sets pagesize to limit + 5');
  assert(calls[0].options.headers.Accept === 'application/json', 'requests JSON');
  assert(results[0]?.engine === 'stackoverflow', 'maps engine field');
  assert(results[0]?.domain === 'stackoverflow.com', 'maps domain field');
  assert(results[0]?.snippet.includes('accepted answer'), 'captures answer quality signals in snippet');
});

await runTest('Stack Overflow skips low-value docs and factual queries before network', async () => {
  const calls = installFetchMock(() => jsonResponse({ items: [] }));

  const docsResults = await searchStackOverflow('nodejs documentation', 3);
  assert(docsResults.length === 0, 'returns no Stack Overflow results for docs-shaped query');
  assert(calls.length === 0, 'does not spend Stack Overflow request on docs-shaped query');

  const factualResults = await searchStackOverflow('what is a large language model', 3);
  assert(factualResults.length === 0, 'returns no Stack Overflow results for factual query');
  assert(calls.length === 0, 'does not spend Stack Overflow request on factual query');
});

await runTest('Stack Overflow handles duplicates, malformed shape, and API backoff', async () => {
  installFetchMock(() => jsonResponse({
    items: [
      { question_id: 1, title: 'A', link: 'https://stackoverflow.com/questions/1/a', tags: ['js'], score: 1, answer_count: 1, is_answered: true },
      { question_id: 2, title: 'A duplicate', link: 'https://stackoverflow.com/questions/1/a', tags: ['js'], score: 2, answer_count: 2, is_answered: true },
    ],
  }));
  let results = await searchStackOverflow('javascript error stackoverflow', 5);
  assert(results.length === 1, 'deduplicates question URLs');

  resetStackOverflow();
  installFetchMock(() => jsonResponse({ nope: [] }));
  await expectThrows(() => searchStackOverflow('javascript error', 1), /unexpected response shape/, 'throws on malformed response');

  resetStackOverflow();
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({
      error_id: 502,
      error_name: 'throttle_violation',
      error_message: 'too many requests',
      backoff: 2,
    });
  });
  const first = await expectThrows(() => searchStackOverflow('javascript error', 1), /throttle_violation/, 'throws typed throttle error');
  assert(first?.provider === 'stackoverflow', 'throttle records provider');
  assert(first?.state === 'rate_limited', 'throttle records rate_limited state');
  assert(first?.retry_after_ms === 2000, 'throttle records backoff ms', `retry_after_ms ${first?.retry_after_ms}`);
  await expectThrows(() => searchStackOverflow('javascript exception', 1), /cooldown active after throttle_violation/, 'short-circuits during API backoff');
  assert(fetchCalls === 1, 'backoff prevents second fetch', `fetch calls ${fetchCalls}`);
});

await runTest('Hacker News maps public Algolia stories and request params', async () => {
  const calls = installFetchMock(() => jsonResponse({
    hits: [
      {
        objectID: '123',
        title: 'Show HN: Vector database',
        url: 'https://example.com/vector-db',
        author: 'alice',
        points: 123,
        num_comments: 45,
        created_at: '2026-05-01T00:00:00Z',
      },
    ],
  }));

  const results = await searchHackerNews('show hn vector database', 5);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://hn.algolia.com/api/v1/search_by_date', 'uses date endpoint for fresh HN query');
  assert(requested.searchParams.get('query') === 'show hn vector database', 'sets HN query parameter');
  assert(requested.searchParams.get('tags') === 'story', 'requests HN stories');
  assert(requested.searchParams.get('hitsPerPage') === '10', 'sets HN hitsPerPage to limit + 5');
  assert(results[0]?.engine === 'hackernews', 'maps HN engine field');
  assert(results[0]?.url === 'https://example.com/vector-db', 'maps HN story URL');
  assert(results[0]?.snippet.includes('45 comments'), 'captures HN discussion signals');
});

await runTest('Hacker News skips low-value docs queries and handles malformed/backoff', async () => {
  let calls = installFetchMock(() => jsonResponse({ hits: [] }));
  const docsResults = await searchHackerNews('nodejs documentation', 3);
  assert(docsResults.length === 0, 'returns no HN results for docs-shaped query');
  assert(calls.length === 0, 'does not spend HN request on docs query');

  resetHackerNews();
  installFetchMock(() => jsonResponse({ nope: [] }));
  await expectThrows(() => searchHackerNews('ask hn database', 1), /unexpected response shape/, 'throws on malformed HN response');

  resetHackerNews();
  let fetchCalls = 0;
  calls = installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ message: 'limit' }, { status: 429, headers: { 'retry-after': '2' } });
  });
  const first = await expectThrows(() => searchHackerNews('ask hn database', 1), /HTTP 429/, 'throws typed HN rate-limit error');
  assert(first?.provider === 'hackernews', 'HN rate limit records provider');
  assert(first?.state === 'rate_limited', 'HN rate limit records state');
  assert(first?.retry_after_ms <= 2000 && first?.retry_after_ms > 0, 'HN rate limit records retry-after ms');
  await expectThrows(() => searchHackerNews('ask hn search', 1), /cooldown active/, 'HN cooldown short-circuits');
  assert(fetchCalls === 1, 'HN cooldown prevents second fetch', `fetch calls ${fetchCalls}`);
  assert(calls.length === 1, 'HN cooldown uses one network call');
});

await runTest('npm maps registry search results and request params', async () => {
  const calls = installFetchMock(() => jsonResponse({
    objects: [
      {
        package: {
          name: 'vite-plugin-example',
          version: '1.2.3',
          description: 'Example Vite plugin',
          publisher: { username: 'builder' },
        },
        score: {
          final: 0.9,
          detail: { quality: 0.8, popularity: 0.7, maintenance: 0.6 },
        },
      },
    ],
  }));

  const results = await searchNpm('vite plugin npm package', 5);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://registry.npmjs.org/-/v1/search', 'uses npm registry search endpoint');
  assert(requested.searchParams.get('text') === 'vite plugin npm package', 'sets npm text parameter');
  assert(requested.searchParams.get('size') === '10', 'sets npm size to limit + 5');
  assert(requested.searchParams.get('quality') === '0.35', 'sets npm quality weight');
  assert(results[0]?.engine === 'npm', 'maps npm engine field');
  assert(results[0]?.domain === 'npmjs.com', 'maps npm domain field');
  assert(results[0]?.url === 'https://www.npmjs.com/package/vite-plugin-example', 'maps npm package URL');
  assert(results[0]?.snippet.includes('quality 0.80'), 'captures npm quality signals');
});

await runTest('npm skips low-value factual queries and handles malformed/backoff', async () => {
  const calls = installFetchMock(() => jsonResponse({ objects: [] }));
  const factualResults = await searchNpm('what is a vector database', 3);
  assert(factualResults.length === 0, 'returns no npm results for factual query');
  assert(calls.length === 0, 'does not spend npm request on factual query');

  resetNpm();
  installFetchMock(() => jsonResponse({ nope: [] }));
  await expectThrows(() => searchNpm('react package', 1), /unexpected response shape/, 'throws on malformed npm response');

  resetNpm();
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ error: 'limit' }, { status: 429, headers: { 'retry-after': '2' } });
  });
  const first = await expectThrows(() => searchNpm('typescript library', 1), /HTTP 429/, 'throws typed npm rate-limit error');
  assert(first?.provider === 'npm', 'npm rate limit records provider');
  assert(first?.state === 'rate_limited', 'npm rate limit records state');
  assert(first?.retry_after_ms <= 2000 && first?.retry_after_ms > 0, 'npm rate limit records retry-after ms');
  await expectThrows(() => searchNpm('react package', 1), /cooldown active/, 'npm cooldown short-circuits');
  assert(fetchCalls === 1, 'npm cooldown prevents second fetch', `fetch calls ${fetchCalls}`);
});

await runTest('official seed engine returns only measured high-signal resources', async () => {
  const node = await searchOfficial('nodejs documentation', 10);
  assert(node.some(item => item.url === 'https://nodejs.org/api/'), 'adds Node.js API documentation seed');
  assert(node.some(item => item.url === 'https://nodejs.org/api/all.html'), 'adds Node.js complete API documentation seed');
  assert(!node.some(item => item.url.includes('developer.mozilla.org')), 'does not inject MDN JavaScript into Node official seeds');
  assert(node.every(item => item.engine === 'official'), 'maps official engine field');

  const robots = await searchOfficial('robots.txt standard', 10);
  assert(robots[0]?.url.includes('rfc9309'), 'robots.txt standard starts with RFC 9309');

  const csv = await searchOfficial('csv file format specification', 10);
  assert(csv[0]?.url.includes('rfc4180'), 'CSV specification starts with RFC 4180');

  const pathlib = await searchOfficial('python pathlib docs', 10);
  assert(pathlib[0]?.url === 'https://docs.python.org/3/library/pathlib.html', 'Python pathlib docs start with official library reference');

  const cargo = await searchOfficial('rust cargo documentation', 10);
  assert(cargo[0]?.url === 'https://doc.rust-lang.org/cargo', 'Rust Cargo docs start with the Cargo Book');
  assert(cargo.some(item => item.url === 'https://doc.rust-lang.org/cargo/reference'), 'Rust Cargo docs include official reference');

  const react = await searchOfficial('react useEffect API reference', 10);
  assert(react[0]?.url === 'https://react.dev/reference/react/useEffect', 'React useEffect starts with official API reference');
  const reactReverse = await searchOfficial('useEffect react docs', 10);
  assert(reactReverse[0]?.url === 'https://react.dev/reference/react/useEffect', 'React useEffect reverse-order query matches');

  const postgres = await searchOfficial('postgresql jsonb documentation', 10);
  assert(postgres[0]?.url === 'https://postgresql.org/docs/current/functions-json.html', 'PostgreSQL JSONB docs start with official JSON functions');
  assert(postgres.some(item => item.domain === 'postgresql.org'), 'PostgreSQL JSONB docs map registrable domain');

  const docker = await searchOfficial('docker compose environment variables', 10);
  assert(docker[0]?.url === 'https://docs.docker.com/compose/environment-variables', 'Docker Compose env vars start with official docs');

  const rebase = await searchOfficial('git rebase interactive guide', 10);
  assert(rebase[0]?.url === 'https://git-scm.com/docs/git-rebase', 'Git rebase starts with official reference');
  assert(rebase.some(item => item.url.includes('Git-Tools-Rewriting-History')), 'Git rebase includes Pro Git rewriting history chapter');

  const playwrightStealth = await searchOfficial('playwright stealth implementation github', 10);
  assert(playwrightStealth[0]?.url === 'https://github.com/berstend/puppeteer-extra', 'Playwright stealth code query starts with judged stealth repository');
  assert(playwrightStealth.some(item => item.url === 'https://github.com/Granitosaurus/playwright-stealth'), 'Playwright stealth includes judged Playwright repository');

  const sqliteNode = await searchOfficial('sqlite node bindings github', 10);
  assert(sqliteNode[0]?.url === 'https://github.com/TryGhost/node-sqlite3', 'SQLite Node bindings start with node-sqlite3');
  assert(sqliteNode.some(item => item.url === 'https://github.com/WiseLibs/better-sqlite3'), 'SQLite Node bindings include better-sqlite3');

  const fastifyWebsocket = await searchOfficial('fastify websocket github example', 10);
  assert(fastifyWebsocket[0]?.url === 'https://github.com/fastify/fastify-websocket', 'Fastify WebSocket starts with Fastify WebSocket repository');
  assert(fastifyWebsocket.some(item => item.url === 'https://github.com/websockets/ws'), 'Fastify WebSocket includes ws fallback repository');

  const rag = await searchOfficial('what is retrieval augmented generation', 10);
  assert(rag[0]?.url === 'https://arxiv.org/abs/2005.11401', 'RAG starts with original arXiv paper');
  assert(rag.some(item => item.url.includes('Retrieval-augmented_generation')), 'RAG includes Wikipedia overview');

  const rustHistory = await searchOfficial('history of rust programming language', 10);
  assert(rustHistory[0]?.url.includes('rustfoundation.org/media/10-years-of-stable-rust'), 'Rust history starts with Rust Foundation history');
  assert(rustHistory.some(item => item.url === 'https://doc.rust-lang.org/book/'), 'Rust history includes official Rust book');

  const vectorDb = await searchOfficial('define vector database', 10);
  assert(vectorDb[0]?.url === 'https://en.wikipedia.org/wiki/Vector_database', 'vector database definition starts with canonical overview');
  assert(vectorDb.some(item => item.url.includes('pinecone.io/learn/vector-database')), 'vector database definition includes explainer');

  const web = await searchOfficial('who invented the world wide web', 10);
  assert(web[0]?.url === 'https://w3.org/People/Berners-Lee', 'World Wide Web inventor starts with W3C Tim Berners-Lee page');

  const artemis = await searchOfficial('nasa artemis program overview', 10);
  assert(artemis[0]?.url === 'https://nasa.gov/humans-in-space/artemis', 'NASA Artemis starts with NASA overview');

  const unicode = await searchOfficial('unicode bidirectional algorithm explanation', 10);
  assert(unicode[0]?.url === 'https://unicode.org/reports/tr9', 'Unicode bidi starts with Unicode Standard Annex 9');

  const cargoShipping = await searchOfficial('cargo shipping documentation', 10);
  assert(cargoShipping.length === 0, 'does not seed non-Rust cargo queries');

  const postgresDiscussion = await searchOfficial('postgres vs sqlite reddit', 10);
  assert(postgresDiscussion.length === 0, 'does not seed unrelated PostgreSQL discussion queries');

  const vectorPricing = await searchOfficial('vector database pricing comparison', 10);
  assert(vectorPricing.length === 0, 'does not seed commercial vector database comparison queries');

  const rustCargo = await searchOfficial('rust cargo documentation', 10);
  assert(rustCargo[0]?.url === 'https://doc.rust-lang.org/cargo', 'Rust Cargo remains routed to Cargo docs');

  const sqliteTutorial = await searchOfficial('sqlite tutorial', 10);
  assert(sqliteTutorial.length === 0, 'does not seed broad SQLite tutorial queries');

  const sqliteComparison = await searchOfficial('sqlite vs postgres reddit', 10);
  assert(sqliteComparison.length === 0, 'does not seed SQLite comparison discussion queries');

  const playwrightDocs = await searchOfficial('playwright documentation', 10);
  assert(!playwrightDocs.some(item => item.url.includes('playwright-stealth') || item.url.includes('puppeteer-extra')), 'does not seed stealth repos for Playwright docs');

  const limited = await searchOfficial('git rebase interactive guide', 2);
  assert(limited.length === 2, 'respects official result limit');
  assert(limited.every((item, index) => item.sourceRank === index + 1), 'assigns stable source ranks');

  const unrelated = await searchOfficial('best local llm reddit discussion', 10);
  assert(unrelated.length === 0, 'does not seed unrelated queries');
});

await runTest('Reddit public mode maps posts and request params', async () => {
  REDDIT_CONFIG.clientId = '';
  REDDIT_CONFIG.clientSecret = '';
  const calls = installFetchMock(() => jsonResponse(redditChildren([
    {
      title: 'Self discussion',
      url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc/self_discussion/',
      permalink: '/r/LocalLLaMA/comments/abc/self_discussion/',
      is_self: true,
      selftext: 'Local LLM notes',
      subreddit: 'LocalLLaMA',
      score: 42,
    },
    {
      title: 'External link',
      url: 'https://example.com/article',
      permalink: '/r/test/comments/def/external/',
      is_self: false,
      subreddit: 'test',
      score: 5,
    },
  ])));

  const results = await searchReddit('local llm', 3);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://www.reddit.com/search.json', 'uses public Reddit search endpoint');
  assert(requested.searchParams.get('q') === 'local llm', 'sets q parameter');
  assert(requested.searchParams.get('limit') === '8', 'sets limit to limit + 5');
  assert(requested.searchParams.get('sort') === 'relevance', 'sets relevance sort');
  assert(requested.searchParams.get('type') === 'sr,link', 'requests subreddit and link result types');
  assert(results[0].url.startsWith('https://www.reddit.com/r/LocalLLaMA/'), 'self post uses Reddit thread URL');
  assert(results[1].url === 'https://example.com/article', 'external post keeps external URL');
});

await runTest('Reddit public mode skips low-value resource queries before network', async () => {
  const calls = installFetchMock(() => jsonResponse(redditChildren([])));

  const results = await searchReddit('nodejs documentation', 3);
  assert(results.length === 0, 'returns no Reddit results for docs-shaped public query');
  assert(calls.length === 0, 'does not spend public Reddit request on docs-shaped query');
});

await runTest('Reddit discussion queries fall back to subreddit candidates during cooldown', async () => {
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ error: 'forbidden' }, { status: 403, headers: { 'retry-after': '20' } });
  });

  let results = await searchReddit('postgres vs sqlite reddit', 5);
  assert(results.some(result => result.url === 'https://www.reddit.com/r/PostgreSQL'), 'adds PostgreSQL subreddit fallback');
  assert(results.some(result => result.url === 'https://www.reddit.com/r/sqlite'), 'adds SQLite subreddit fallback');
  assert(!results.some(result => result.url === 'https://www.reddit.com/r/PostgreSQLsqlite'), 'does not combine two sides of a comparison into one subreddit');

  results = await searchReddit('mechanical keyboard switch comparison reddit', 8);
  assert(results.some(result => result.url === 'https://www.reddit.com/r/MechanicalKeyboards'), 'serves subreddit fallback while cooldown is active');
  assert(fetchCalls === 1, 'cooldown fallback avoids a second Reddit fetch', `fetch calls ${fetchCalls}`);
});

await runTest('Reddit handles duplicates, malformed shape, and 429 cooldown', async () => {
  installFetchMock(() => jsonResponse(redditChildren([
    { title: 'A', url: 'https://example.com/a', permalink: '/r/x/1', subreddit: 'x', score: 1 },
    { title: 'B', url: 'https://example.com/a', permalink: '/r/x/2', subreddit: 'x', score: 2 },
  ])));
  let results = await searchReddit('dup', 5);
  assert(results.length === 1, 'deduplicates canonical post URLs');

  resetReddit();
  installFetchMock(() => jsonResponse({ data: {} }));
  await expectThrows(() => searchReddit('bad', 1), /unexpected response shape/, 'throws on malformed response');

  resetReddit();
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } });
  });
  await expectThrows(() => searchReddit('cooldown', 1), /HTTP 429; cooling down/, 'throws first 429 cooldown');
  await expectThrows(() => searchReddit('cooldown again', 1), /cooldown active after HTTP 429/, 'short-circuits while cooldown is active');
  assert(fetchCalls === 1, 'cooldown prevents second fetch', `fetch calls ${fetchCalls}`);

  resetReddit();
  fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ error: 'forbidden' }, { status: 403, headers: { 'retry-after': '3' } });
  });
  const first403 = await expectThrows(() => searchReddit('forbidden', 1), /HTTP 403; cooling down/, 'throws typed 403 cooldown');
  assert(first403?.provider === 'reddit', '403 cooldown records provider');
  assert(first403?.state === 'cooldown', '403 cooldown records state');
  assert(first403?.code === 'cooldown', '403 cooldown records code');
  assert(first403?.status === 403, '403 cooldown records HTTP status');
  assert(first403?.degradation === true, '403 cooldown is marked as degradation');
  assert(first403?.retry_after_ms === 3000, '403 cooldown records retry-after ms', `retry_after_ms ${first403?.retry_after_ms}`);
  const second403 = await expectThrows(() => searchReddit('forbidden again', 1), /cooldown active after HTTP 403/, 'short-circuits typed 403 cooldown');
  assert(second403?.state === 'cooldown', '403 short-circuit keeps cooldown state');
  assert(fetchCalls === 1, '403 cooldown prevents second fetch', `fetch calls ${fetchCalls}`);
});

await runTest('Reddit OAuth fetches token and uses bearer search', async () => {
  REDDIT_CONFIG.clientId = 'client';
  REDDIT_CONFIG.clientSecret = 'secret';
  const calls = installFetchMock((url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') {
      return jsonResponse({ access_token: 'token-123', expires_in: 3600 });
    }
    return jsonResponse(redditChildren([
      { title: 'OAuth result', url: 'https://example.com/oauth', permalink: '/r/x/1', subreddit: 'x', score: 1 },
    ]));
  });

  const results = await searchReddit('oauth', 1);
  assert(calls.length === 2, 'fetches token then searches');
  assert(calls[0].options.method === 'POST', 'token request uses POST');
  assert(/^Basic /.test(calls[0].options.headers.Authorization), 'token request uses Basic auth');
  assert(new URL(calls[1].url).origin === 'https://oauth.reddit.com', 'search uses OAuth host');
  assert(calls[1].options.headers.Authorization === 'Bearer token-123', 'search uses bearer token');
  assert(results.length === 1, 'maps OAuth search result');
});

await runTest('Wikipedia performs search then extract and maps pages', async () => {
  const calls = installFetchMock((url, _options, index) => {
    if (index === 0) {
      return jsonResponse({ query: { search: [{ pageid: 101, title: 'Large language model' }] } });
    }
    return jsonResponse({
      query: {
        pages: {
          101: {
            pageid: 101,
            title: 'Large language model',
            extract: 'A large language model is a language model notable for general-purpose language generation.',
            fullurl: 'https://en.wikipedia.org/wiki/Large_language_model',
          },
        },
      },
    });
  });

  const results = await searchWikipedia('large language model', 2);
  const searchUrl = new URL(calls[0].url);
  const extractUrl = new URL(calls[1].url);
  assert(searchUrl.searchParams.get('list') === 'search', 'first call uses search list');
  assert(searchUrl.searchParams.get('srsearch') === 'large language model', 'first call sets srsearch');
  assert(extractUrl.searchParams.get('pageids') === '101', 'second call requests pageids');
  assert(extractUrl.searchParams.get('prop') === 'extracts|info', 'second call requests extracts and info');
  assert(results[0]?.engine === 'wikipedia', 'maps engine field');
});

await runTest('Wikipedia handles empty searches, disambiguation, and 429 cooldown', async () => {
  let calls = installFetchMock(() => jsonResponse({ query: { search: [] } }));
  let results = await searchWikipedia('empty', 2);
  assert(results.length === 0, 'returns empty array for no search results');
  assert(calls.length === 1, 'does not fetch extracts for empty search');

  resetWikipedia();
  installFetchMock((url, _options, index) => {
    if (index === 0) return jsonResponse({ query: { search: [{ pageid: 1, title: 'Mercury (disambiguation)' }] } });
    return jsonResponse({ query: { pages: { 1: { title: 'Mercury (disambiguation)', extract: 'Mercury may refer to:', fullurl: 'https://en.wikipedia.org/wiki/Mercury' } } } });
  });
  results = await searchWikipedia('mercury', 2);
  assert(results.length === 0, 'skips disambiguation pages');

  resetWikipedia();
  let fetchCalls = 0;
  installFetchMock(() => {
    fetchCalls += 1;
    return jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } });
  });
  await expectThrows(() => searchWikipedia('cooldown', 1), /HTTP 429; cooling down/, 'throws first Wikipedia 429');
  await expectThrows(() => searchWikipedia('cooldown again', 1), /cooldown active after HTTP 429/, 'short-circuits Wikipedia cooldown');
  assert(fetchCalls === 1, 'Wikipedia cooldown prevents second fetch', `fetch calls ${fetchCalls}`);
});

await runTest('Brave API maps results and request headers', async () => {
  SEARCH_CONFIG.braveMode = 'api';
  SEARCH_CONFIG.braveApiKey = 'test-key';
  const calls = installFetchMock(() => jsonResponse({
    web: {
      results: [
        { title: 'Brave Result', url: 'https://example.com/brave', description: 'Brave description' },
      ],
    },
  }));

  const results = await searchBrave('brave query', 4);
  const requested = new URL(calls[0].url);
  assert(requested.origin + requested.pathname === 'https://api.search.brave.com/res/v1/web/search', 'uses Brave API endpoint');
  assert(requested.searchParams.get('q') === 'brave query', 'sets q parameter');
  assert(requested.searchParams.get('count') === '9', 'sets count to limit + 5');
  assert(calls[0].options.headers['X-Subscription-Token'] === 'test-key', 'sets Brave API key header');
  assert(results[0]?.engine === 'brave', 'maps engine field');
});

await runTest('Brave API handles missing key, auth failure, and malformed shape', async () => {
  SEARCH_CONFIG.braveMode = 'api';
  SEARCH_CONFIG.braveApiKey = '';
  await expectThrows(() => searchBrave('missing key', 1), /BRAVE_SEARCH_API_KEY is not set/, 'throws when API key is missing');

  SEARCH_CONFIG.braveApiKey = 'bad-key';
  installFetchMock(() => jsonResponse({ message: 'bad auth' }, { status: 401 }));
  await expectThrows(() => searchBrave('bad auth', 1), /authentication failed \(401\)/, 'throws on Brave auth failure');

  installFetchMock(() => jsonResponse({}));
  await expectThrows(() => searchBrave('bad shape', 1), /unexpected response shape/, 'throws on malformed Brave response');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
console.log('─'.repeat(50));

process.exit(failed > 0 ? 1 : 0);

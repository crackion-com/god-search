/**
 * Offline adaptive SERP extraction contract tests.
 *
 * Run:
 *   node test/verify-extraction.js
 *   bun test/verify-extraction.js
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'serp');

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

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function splitTopLevel(input, delimiter) {
  const parts = [];
  let current = '';
  let square = 0;
  let paren = 0;
  let quote = '';

  for (const ch of input) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') square += 1;
    if (ch === ']') square -= 1;
    if (ch === '(') paren += 1;
    if (ch === ')') paren -= 1;
    if (ch === delimiter && square === 0 && paren === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelectorSteps(selector) {
  const steps = [];
  let current = '';
  let combinator = ' ';
  let square = 0;
  let paren = 0;
  let quote = '';

  function pushCurrent() {
    const simple = current.trim();
    if (simple) steps.push({ combinator, simple });
    current = '';
    combinator = ' ';
  }

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') square += 1;
    if (ch === ']') square -= 1;
    if (ch === '(') paren += 1;
    if (ch === ')') paren -= 1;

    if (square === 0 && paren === 0 && ch === '>') {
      pushCurrent();
      combinator = '>';
      continue;
    }

    if (square === 0 && paren === 0 && /\s/.test(ch)) {
      pushCurrent();
      while (i + 1 < selector.length && /\s/.test(selector[i + 1])) i += 1;
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return steps;
}

function parseAttrs(rawAttrs) {
  const attrs = {};
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(rawAttrs))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

class TestTextNode {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.text = decodeEntities(text);
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
  }

  get innerText() {
    return this.text;
  }

  get textContent() {
    return this.text;
  }
}

class TestElement {
  constructor(tagName, attrs = {}, ownerDocument = null) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.attrs = attrs;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.childNodes = [];
    this.classList = {
      contains: (name) => this.className.split(/\s+/).filter(Boolean).includes(name),
    };
  }

  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
  }

  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  get parentNode() {
    return this.parentElement;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  get href() {
    const href = this.getAttribute('href') || '';
    try {
      return new URL(href, this.ownerDocument?.baseUrl || 'https://search.example/').toString();
    } catch {
      return href;
    }
  }

  getBoundingClientRect() {
    const textLength = Math.max(1, this.innerText.length);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: Math.min(640, 24 + textLength * 7),
      bottom: 18,
      width: Math.min(640, 24 + textLength * 7),
      height: 18,
    };
  }

  get innerText() {
    if (this.localName === 'script' || this.localName === 'style') return '';
    return this.childNodes.map(child => child.innerText).join('').replace(/\s+/g, ' ').trim();
  }

  get textContent() {
    return this.childNodes.map(child => child.textContent).join('');
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, String(name).toLowerCase());
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return querySelectorAllWithin(this, selector);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    return splitTopLevel(selector, ',').some(part => matchesSimpleSelector(this, part.trim()));
  }
}

class TestDocument extends TestElement {
  constructor(baseUrl = 'https://search.example/search?q=adaptive+extraction') {
    super('#document', {}, null);
    this.nodeType = 9;
    this.ownerDocument = this;
    this.baseUrl = baseUrl;
    this.location = new URL(baseUrl);
  }

  get body() {
    return this.querySelector('body') || this;
  }

  get documentElement() {
    return this.querySelector('html') || this;
  }

  get title() {
    return this.querySelector('title')?.innerText || '';
  }
}

function getDescendants(root) {
  const out = [];
  const stack = [...root.children];
  while (stack.length) {
    const node = stack.shift();
    out.push(node);
    stack.unshift(...node.children);
  }
  return out;
}

function querySelectorAllWithin(root, selector) {
  const seen = new Set();
  const results = [];

  for (const group of splitTopLevel(selector, ',')) {
    const steps = parseSelectorSteps(group);
    if (steps.length === 0) continue;

    let current = [root];
    for (const [index, step] of steps.entries()) {
      const next = [];
      for (const node of current) {
        const candidates = index === 0 || step.combinator === ' ' ? getDescendants(node) : node.children;
        for (const candidate of candidates) {
          if (matchesSimpleSelector(candidate, step.simple)) next.push(candidate);
        }
      }
      current = next;
    }

    for (const node of current) {
      if (!seen.has(node)) {
        seen.add(node);
        results.push(node);
      }
    }
  }

  return results;
}

function matchesSimpleSelector(element, rawSimple) {
  if (!rawSimple || rawSimple === '*') return true;
  let simple = rawSimple.trim();

  const notParts = [];
  simple = simple.replace(/:not\(([^()]+)\)/g, (_, inner) => {
    notParts.push(inner.trim());
    return '';
  });
  simple = simple.replace(/:(first-child|last-child|nth-child\([^)]*\))/g, '');

  for (const notSelector of notParts) {
    if (matchesSimpleSelector(element, notSelector)) return false;
  }

  const tagMatch = simple.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch && element.localName !== tagMatch[0].toLowerCase()) return false;

  const idMatches = [...simple.matchAll(/#([\w-]+)/g)].map(match => match[1]);
  if (idMatches.some(id => element.id !== id)) return false;

  const classMatches = [...simple.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  if (classMatches.some(name => !element.classList.contains(name))) return false;

  const attrMatches = [...simple.matchAll(/\[([^\]\s~|^$*!=]+)\s*(?:(\^=|\*=|\$=|=)\s*["']?([^"'\]]+?)["']?)?\s*(i)?\]/g)];
  for (const [, rawName, operator, expected = '', insensitive] of attrMatches) {
    const value = element.getAttribute(rawName);
    if (value === null) return false;
    const actualValue = insensitive ? value.toLowerCase() : value;
    const expectedValue = insensitive ? expected.toLowerCase() : expected;
    if (!operator) continue;
    if (operator === '=' && actualValue !== expectedValue) return false;
    if (operator === '*=' && !actualValue.includes(expectedValue)) return false;
    if (operator === '^=' && !actualValue.startsWith(expectedValue)) return false;
    if (operator === '$=' && !actualValue.endsWith(expectedValue)) return false;
  }

  return true;
}

function parseHtml(html, baseUrl) {
  const document = new TestDocument(baseUrl);
  const stack = [document];
  const tokenPattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/gi;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let match;

  while ((match = tokenPattern.exec(html))) {
    const token = match[0];
    if (!token || token.startsWith('<!--') || /^<!doctype/i.test(token)) continue;

    if (token.startsWith('</')) {
      const closingTag = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1 && stack.at(-1).localName !== closingTag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }

    if (token.startsWith('<')) {
      const tagMatch = token.match(/^<\s*([a-zA-Z][\w-]*)([\s\S]*?)\/?\s*>$/);
      if (!tagMatch) continue;
      const [, tagName, rawAttrs] = tagMatch;
      const element = new TestElement(tagName, parseAttrs(rawAttrs), document);
      stack.at(-1).appendChild(element);
      if (!voidTags.has(tagName.toLowerCase()) && !token.endsWith('/>')) stack.push(element);
      continue;
    }

    if (token.trim()) stack.at(-1).appendChild(new TestTextNode(token, document));
  }

  return document;
}

class FixturePage {
  constructor(html, url = 'https://search.example/search?q=adaptive+extraction') {
    this.html = html;
    this.document = parseHtml(html, url);
    this._url = url;
  }

  url() {
    return this._url;
  }

  async content() {
    return this.html;
  }

  async evaluate(fn, ...args) {
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      location: globalThis.location,
      getComputedStyle: globalThis.getComputedStyle,
    };
    const getComputedStyle = () => ({
      visibility: 'visible',
      display: 'block',
      opacity: '1',
    });
    const window = {
      document: this.document,
      location: this.document.location,
      URL,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
      getComputedStyle,
    };

    globalThis.document = this.document;
    globalThis.window = window;
    globalThis.location = this.document.location;
    globalThis.getComputedStyle = getComputedStyle;

    try {
      return await fn(...args);
    } finally {
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.location === undefined) delete globalThis.location;
      else globalThis.location = previous.location;
      if (previous.getComputedStyle === undefined) delete globalThis.getComputedStyle;
      else globalThis.getComputedStyle = previous.getComputedStyle;
    }
  }
}

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listJsFiles(fullPath));
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

async function discoverExtractionApi() {
  const srcFiles = await listJsFiles(path.join(repoRoot, 'src'));
  const candidates = [];

  for (const file of srcFiles) {
    const mod = await import(pathToFileURL(file).href);
    const rel = path.relative(repoRoot, file);
    for (const name of [
      'extractSerpResultsFromHtml',
      'extractResultsFromHtml',
      'extractOrganicResultsFromHtml',
      'extractSerpFromHtml',
    ]) {
      if (typeof mod[name] === 'function') candidates.push({ kind: 'html', name, rel, fn: mod[name] });
    }
    for (const name of [
      'extractSerpResultsFromDocument',
      'extractResultsFromDocument',
      'extractOrganicResultsFromDocument',
      'extractSerpFromDocument',
    ]) {
      if (typeof mod[name] === 'function') candidates.push({ kind: 'document', name, rel, fn: mod[name] });
    }
    if (typeof mod.extractSerpResults === 'function') {
      candidates.push({ kind: 'page', name: 'extractSerpResults', rel, fn: mod.extractSerpResults });
    }
  }

  const order = { html: 0, document: 1, page: 2 };
  candidates.sort((a, b) => order[a.kind] - order[b.kind]);
  return candidates[0] || null;
}

async function loadFixture(name) {
  return readFile(path.join(fixtureDir, name), 'utf8');
}

async function runExtraction(api, fixtureName) {
  const html = await loadFixture(fixtureName);
  const url = `https://search.example/search?q=adaptive+extraction&fixture=${encodeURIComponent(fixtureName)}`;
  const config = {
    engine: 'google',
    query: 'adaptive extraction',
    limit: 10,
    maxResults: 10,
    url,
    baseUrl: 'https://www.google.com/search?q=adaptive+extraction',
    adSignals: ['sponsored placement', 'paid search', 'shopping result noise'],
    engineHostnames: ['search.example'],
    primarySelectors: {
      result: ['div.g:not([data-text-ad])'],
      title: ['h3'],
      link: ['a[href]'],
    },
  };

  if (fixtureName === 'mutated.html') {
    config.primarySelectors = {
      result: ['.missing-result-selector'],
      title: ['.missing-title-selector'],
      link: ['.missing-link-selector'],
    };
  }

  if (api.kind === 'html') return api.fn(html, config);
  if (api.kind === 'document') return api.fn(parseHtml(html, url), config);
  return api.fn(new FixturePage(html, url), config);
}

function resultList(output) {
  if (Array.isArray(output)) return output;
  for (const key of ['results', 'items', 'organicResults', 'organic', 'serpResults']) {
    if (Array.isArray(output?.[key])) return output[key];
  }
  if (Array.isArray(output?.data?.results)) return output.data.results;
  return [];
}

function diagnostics(output) {
  if (!output || Array.isArray(output)) return {};
  return output.diagnostics || output.diagnostic || output.meta || output.metadata || {};
}

function statusText(output) {
  const diag = diagnostics(output);
  return String(output?.status || output?.state || output?.classification || diag.status || diag.state || diag.reason || '').toLowerCase();
}

function confidenceValue(output) {
  const diag = diagnostics(output);
  const value = output?.confidence ?? output?.serpConfidence ?? diag.confidence ?? diag.serpConfidence;
  return typeof value === 'number' ? value : Number(value);
}

function urlOf(result) {
  return result?.url || result?.href || result?.link || '';
}

function titleOf(result) {
  return result?.title || result?.name || '';
}

function uniqueUrls(results) {
  return new Set(results.map(urlOf).filter(Boolean));
}

const EXPECTED_ORGANIC_URLS = [
  'https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelectorAll',
  'https://docs.python.org/3/library/html.parser.html',
  'https://nodejs.org/api/url.html',
  'https://playwright.dev/docs/evaluating',
  'https://developer.chrome.com/docs/devtools/',
  'https://web.dev/articles/accessibility',
  'https://www.w3.org/TR/selectors-4/',
  'https://html.spec.whatwg.org/multipage/',
  'https://developer.mozilla.org/en-US/docs/Web/API/Element/closest',
  'https://tc39.es/ecma262/',
];

function normalizedUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function missingExpectedUrls(results) {
  const actual = new Set(results.map(result => normalizedUrl(urlOf(result))));
  return EXPECTED_ORGANIC_URLS.filter(url => !actual.has(normalizedUrl(url)));
}

function extractionMode(output) {
  return String(output?.mode || output?.extractionMode || diagnostics(output)?.mode || '').toLowerCase();
}

function looksBlocked(output) {
  const diag = diagnostics(output);
  const classification = diag.classification || {};
  const signals = classification.signals || diag.signals || {};
  const status = statusText(output);
  return Boolean(output?.blocked || output?.isBlocked || diagnostics(output).blocked) ||
    status === 'blocked' ||
    status === 'captcha' ||
    status === 'challenge' ||
    Boolean(signals.blocked?.length || signals.blockedSelectors?.length);
}

function looksTrueEmpty(output) {
  const diag = diagnostics(output);
  const classification = diag.classification || {};
  const signals = classification.signals || diag.signals || {};
  const status = statusText(output);
  return Boolean(output?.isEmpty || output?.noResults || diag.isEmpty || diag.noResults === true) ||
    status === 'empty' ||
    status === 'no_results' ||
    status === 'no-results' ||
    status === 'true_empty' ||
    Boolean(signals.noResults?.length);
}

function hasDiagnostics(output) {
  if (!output || Array.isArray(output)) return false;
  const hasStatus = statusText(output).length > 0;
  const confidence = confidenceValue(output);
  return hasStatus && Number.isFinite(confidence);
}

const api = await discoverExtractionApi();

if (!api) {
  console.log(`${FAIL} No adaptive SERP extraction export was found.`);
  console.log('Expected one of: extractSerpResultsFromHtml, extractSerpResultsFromDocument, extractSerpResults.');
  console.log('Searched JS modules under src/.');
  process.exit(1);
}

console.log(`${INFO} Using ${api.name} from ${api.rel} (${api.kind})`);

await runTest('synthetic SERP recovers 10 unique organic results and filters noise', async () => {
  const output = await runExtraction(api, 'synthetic.html');
  const results = resultList(output);
  const urls = [...uniqueUrls(results)];
  const missing = missingExpectedUrls(results);

  assert(results.length >= 10, `got at least 10 organic results`, `got ${results.length}`);
  assert(urls.length === results.length, 'duplicate URLs are collapsed', `unique=${urls.length}, results=${results.length}`);
  assert(missing.length === 0, 'returns full expected organic URL set', missing.join(', '));
  assert(urlOf(results[0]) === EXPECTED_ORGANIC_URLS[0], 'preserves expected top result order', `top=${urlOf(results[0])}`);
  assert(results.some(r => /Document querySelectorAll API/i.test(titleOf(r))), 'keeps expected organic title');
  assert(urls.some(url => url === 'https://docs.python.org/3/library/html.parser.html'), 'decodes search redirect URL');
  assert(!urls.some(url => /ads\.example|shopping\.example|maps\.example|search\.example/.test(url)), 'filters ads, nav, footer, and vertical noise');
  assert(hasDiagnostics(output), 'exposes status and numeric confidence diagnostics');
});

await runTest('mutated fixture falls back when primary selectors and snippets are missing', async () => {
  const output = await runExtraction(api, 'mutated.html');
  const results = resultList(output);
  const urls = [...uniqueUrls(results)];
  const missing = missingExpectedUrls(results);
  const byMode = diagnostics(output)?.candidateCounts?.byMode || {};

  assert(results.length >= 10, 'generic fallback recovers organic results', `got ${results.length}`);
  assert(missing.length === 0, 'mutated fixture returns full expected URL set', missing.join(', '));
  assert(urls.some(url => url === 'https://developer.chrome.com/docs/devtools/'), 'keeps snippetless organic result');
  assert(!urls.some(url => /ads\.example|search\.example/.test(url)), 'filters injected nav/footer/ad noise');
  assert(!looksTrueEmpty(output), 'selector failure is not classified as true empty SERP');
  assert(extractionMode(output) !== 'primary', 'mutated fixture does not pass via primary selectors', `mode=${extractionMode(output)}`);
  assert((byMode.semantic || 0) + (byMode.heuristic || 0) + (byMode.fallback || 0) > 0, 'mutated fixture used non-primary candidate path');
  assert(hasDiagnostics(output), 'exposes fallback status and numeric confidence diagnostics');
});

await runTest('blocked CAPTCHA fixture is not treated as a valid SERP', async () => {
  const output = await runExtraction(api, 'blocked.html');
  const results = resultList(output);
  const confidence = confidenceValue(output);

  assert(looksBlocked(output), 'reports blocked/CAPTCHA status');
  assert(results.length === 0, 'does not return organic results from blocked page', `got ${results.length}`);
  assert(!/^ok$|^success$|^valid$|^serp$/.test(statusText(output)), 'blocked page is not marked as valid SERP');
  assert(Number.isFinite(confidence), 'blocked output exposes numeric confidence');
});

await runTest('no-results fixture is distinguished from selector failure', async () => {
  const output = await runExtraction(api, 'no-results.html');
  const results = resultList(output);

  assert(results.length === 0, 'returns no organic results for true empty SERP', `got ${results.length}`);
  assert(looksTrueEmpty(output), 'reports true no-results status');
  assert(!looksBlocked(output), 'does not classify no-results page as blocked');
  assert(hasDiagnostics(output), 'no-results output exposes status and numeric confidence diagnostics');
});

await runTest('mixed robot/no-results wording still extracts organic results', async () => {
  const output = await runExtraction(api, 'ambiguous-signals.html');
  const results = resultList(output);
  const urls = [...uniqueUrls(results)];

  assert(!looksBlocked(output), 'robot-topic page is not classified as blocked');
  assert(!looksTrueEmpty(output), 'no-results hint with organic anchors is not classified true empty');
  assert(results.length >= 3, 'extracts organic results despite ambiguous wording', `got ${results.length}`);
  assert(urls.some(url => url === 'https://www.robotstxt.org/robotstxt.html'), 'keeps expected robots.txt result');
  assert(hasDiagnostics(output), 'ambiguous output exposes status and numeric confidence diagnostics');
});

console.log(`\n${'='.repeat(56)}`);
console.log(`Extraction fixture tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(56));

process.exit(failed > 0 ? 1 : 0);

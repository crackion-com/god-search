import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const BRAVE_URL = 'https://search.brave.com/search';
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
let _challengeCooldown = 0;

async function searchBraveViaApi(query, limit = 10) {
  if (!SEARCH_CONFIG.braveApiKey) {
    throw new Error('Brave API mode requested but BRAVE_SEARCH_API_KEY is not set');
  }

  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit + 5, 20)));
  url.searchParams.set('country', SEARCH_CONFIG.braveApiCountry);
  url.searchParams.set('search_lang', SEARCH_CONFIG.braveApiSearchLang);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_CONFIG.apiTimeoutMs);

  let data;
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': SEARCH_CONFIG.braveApiKey,
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Brave API: authentication failed (${resp.status})`);
    }
    if (!resp.ok) throw new Error(`Brave API: HTTP ${resp.status}`);
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const results = data?.web?.results;
  if (!Array.isArray(results)) {
    throw new Error('Brave API: unexpected response shape');
  }

  return results
    .map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: (item.description || '').slice(0, 300),
    }))
    .filter(item => item.title && item.url)
    .map(item => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      score: scoreResult(query, item.url, item.title, item.snippet),
      domain: registrableDomain(item.url),
      engine: 'brave',
    }))
    .slice(0, limit);
}

function shouldUseBraveApi() {
  if (SEARCH_CONFIG.braveMode === 'api') return true;
  if (SEARCH_CONFIG.braveMode === 'scrape') return false;
  return !!SEARCH_CONFIG.braveApiKey;
}

export async function searchBrave(query, limit = 10) {
  if (shouldUseBraveApi()) {
    return searchBraveViaApi(query, limit);
  }

  if (Date.now() < _challengeCooldown) throw new Error('Brave challenge page — 30s cooldown');

  return withBrowserPage(async (page) => {
    const url = new URL(BRAVE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('source', 'web');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    await page.waitForSelector('[data-type="web"] a[href], .snippet-title a[href], .result-title a[href], main a[href^="http"]', { timeout: 3000 }).catch(() => {});

    const challenged = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const body = document.body?.innerText?.toLowerCase() || '';
      return title.includes('pow captcha') || body.includes('confirm you’re a human being') || body.includes("i'm not a robot");
    });
    if (challenged) {
      _challengeCooldown = Date.now() + 30_000;
      throw new Error('Brave challenge page — 30s cooldown');
    }

    const raw = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      const containers = document.querySelectorAll('[data-type="web"]');
      for (const container of containers) {
        if (container.id === 'summarizer' || container.closest('#summarizer')) continue;
        const linkEl = container.querySelector('a[href]');
        if (!linkEl) continue;
        const href = linkEl.getAttribute('href') || '';
        if (!href.startsWith('http') || seen.has(href)) continue;
        seen.add(href);
        const titleEl =
          container.querySelector('.title') ||
          container.querySelector('.heading') ||
          container.querySelector('h2, h3');
        if (!titleEl) continue;
        const snippetEl =
          container.querySelector('.snippet-content') ||
          container.querySelector('.snippet') ||
          container.querySelector('.description') ||
          container.querySelector('p');
        items.push({ title: titleEl.innerText.trim(), url: href, snippet: snippetEl ? snippetEl.innerText.trim() : '' });
        if (items.length >= 15) break;
      }

      if (items.length === 0) {
        document.querySelectorAll('.snippet-title a[href], .result-title a[href]').forEach(a => {
          const href = a.getAttribute('href');
          if (!href?.startsWith('http') || seen.has(href)) return;
          seen.add(href);
          items.push({ title: a.innerText.trim(), url: href, snippet: '' });
        });
      }

      if (items.length === 0) {
        document.querySelectorAll('main a[href^="http"], a[href^="http"]').forEach(a => {
          if (items.length >= 15) return;
          const href = a.getAttribute('href') || '';
          if (!href.startsWith('http') || seen.has(href)) return;
          try {
            const u = new URL(href);
            if (/search\.brave\.com$/i.test(u.hostname)) return;
          } catch {
            return;
          }
          const title =
            a.innerText.trim() ||
            a.closest('article, section, div, li')?.querySelector('h1, h2, h3')?.innerText.trim() ||
            '';
          if (!title || title.length < 3) return;
          const snippet =
            a.closest('article, section, div, li')?.querySelector('p')?.innerText.trim() ||
            '';
          seen.add(href);
          items.push({ title, url: href, snippet });
        });
      }

      return items;
    });

    return raw
      .filter(r => r.title && r.url)
      .map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet.slice(0, 300),
        score: scoreResult(query, r.url, r.title, r.snippet),
        domain: registrableDomain(r.url),
        engine: 'brave',
      }))
      .slice(0, limit);
  });
}

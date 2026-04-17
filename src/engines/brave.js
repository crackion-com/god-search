import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';

const BRAVE_URL = 'https://search.brave.com/search';
const TIMEOUT_MS = 10000;

export async function searchBrave(query, limit = 10) {
  return withBrowserPage(async (page) => {
    const url = new URL(BRAVE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('source', 'web');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

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

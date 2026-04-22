import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const BING_URL = 'https://www.bing.com/search';

export async function searchBing(query, limit = 10) {
  return withBrowserPage(async (page) => {
    const url = new URL(BING_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', '10');
    url.searchParams.set('setLang', 'en');
    url.searchParams.set('cc', 'US');
    url.searchParams.set('mkt', 'en-US');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    await page.waitForSelector('li.b_algo h2 a', { timeout: 5000 }).catch(() => {});

    await page.evaluate(() => {
      const btn = document.querySelector('#bnp_btn_accept, button[id*="accept"]');
      if (btn) btn.click();
    });

    const raw = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      function decodeBingUrl(href) {
        try {
          if (!href.includes('bing.com/ck/a')) return href;
          const u = new URL(href);
          const encoded = u.searchParams.get('u') || '';
          if (!encoded) return href;
          const decoded = atob(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
          return decoded.startsWith('http') ? decoded : href;
        } catch { return href; }
      }

      for (const container of document.querySelectorAll('li.b_algo')) {
        const titleLink = container.querySelector('h2 a');
        if (!titleLink) continue;
        const rawHref = titleLink.getAttribute('href') || '';
        if (!rawHref.startsWith('http')) continue;
        const realUrl = decodeBingUrl(rawHref);
        if (seen.has(realUrl)) continue;
        seen.add(realUrl);
        const snippetEl =
          container.querySelector('.b_caption p') ||
          container.querySelector('.b_snippet') ||
          container.querySelector('[class*="caption"]');
        items.push({ title: titleLink.innerText.trim(), url: realUrl, snippet: snippetEl ? snippetEl.innerText.trim() : '' });
        if (items.length >= 15) break;
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
        engine: 'bing',
      }))
      .slice(0, limit);
  });
}

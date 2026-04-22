import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

let _challengeCooldown = 0;

export async function searchDdg(query, limit = 10) {
  if (Date.now() < _challengeCooldown) throw new Error('DDG in CAPTCHA cooldown');

  return withBrowserPage(async (page) => {
    const url = new URL(DDG_HTML_URL);
    url.searchParams.set('q', query);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    const challenged = await page.evaluate(() => {
      const hasCaptcha = !!document.querySelector('#challenge-form, #captcha-form, .cf-challenge-running');
      const hasResults = !!document.querySelector('.result__title, .result__a, .result');
      const isBlocked = /checking your browser|unusual traffic|enable javascript/i.test(document.body?.innerText ?? '');
      return hasCaptcha || isBlocked || (!hasResults && (document.body?.innerText ?? '').length < 2000);
    });

    if (challenged) {
      _challengeCooldown = Date.now() + 30_000;
      throw new Error('DDG challenge page — 30s cooldown');
    }

    const raw = await page.evaluate(() => {
      const items = [];
      const containers = document.querySelectorAll('.result:not(.result--ad), .web-result');
      for (const container of containers) {
        const titleEl = container.querySelector('.result__title a, a.result__a');
        if (!titleEl) continue;
        let url = titleEl.getAttribute('href') || '';
        try {
          const u = new URL(url, 'https://html.duckduckgo.com');
          const uddg = u.searchParams.get('uddg');
          if (uddg) url = decodeURIComponent(uddg);
          if (u.hostname === 'duckduckgo.com' && !uddg) url = '';
        } catch {}
        if (!url.startsWith('http')) continue;
        const snippetEl = container.querySelector('.result__snippet, a.result__snippet');
        items.push({ title: titleEl.innerText.trim(), url, snippet: snippetEl ? snippetEl.innerText.trim() : '' });
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
        engine: 'ddg',
      }))
      .slice(0, limit);
  });
}

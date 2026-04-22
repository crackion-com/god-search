import { withBrowserPage } from '../browser.js';
import { scoreResult, registrableDomain } from '../scoring.js';
import { SEARCH_CONFIG } from '../config.js';

const GOOGLE_URL = 'https://www.google.com/search';

let _challengeCooldown = 0;

export async function searchGoogle(query, limit = 10) {
  if (Date.now() < _challengeCooldown) throw new Error('Google in CAPTCHA cooldown');

  return withBrowserPage(async (page) => {
    const url = new URL(GOOGLE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '10');
    url.searchParams.set('hl', 'en');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.searchTimeoutMs });

    const challenged = await page.evaluate(() => {
      const hasCaptcha = !!document.querySelector('#captcha-form, #recaptcha, form[action*="CaptchaRedirect"]');
      const title = document.title.toLowerCase();
      const isUnusual = title.includes('unusual traffic') || title.includes('before you continue');
      const hasResults = !!document.querySelector('h3, [data-hveid]');
      return hasCaptcha || isUnusual || !hasResults;
    });

    if (challenged) {
      _challengeCooldown = Date.now() + 30_000;
      throw new Error('Google challenge page — 30s cooldown');
    }

    await page.evaluate(() => {
      const btn = document.querySelector('button[id*="accept"], button[aria-label*="Accept all"]');
      if (btn) btn.click();
    });

    const raw = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      const containers = [
        ...document.querySelectorAll('div#search div.g'),
        ...document.querySelectorAll('div[data-hveid][data-ved]:not([data-rw])'),
      ];

      for (const container of containers) {
        if (container.querySelector('[data-rw]') || container.closest('[data-text-ad]')) continue;
        if (container.classList.contains('kp-wholepage')) continue;
        if (container.querySelector('[data-sgrd]') || container.closest('[data-sgrd]')) continue;
        if (container.querySelector('g-scrolling-carousel')) continue;
        const h3 = container.querySelector('h3');
        if (!h3) continue;
        const linkEl = container.querySelector('a[href]');
        if (!linkEl) continue;
        const href = linkEl.getAttribute('href') || '';
        if (!href.startsWith('http') || href.includes('/search?') || href.includes('google.com/search')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const snippetEl =
          container.querySelector('[data-sncf]') ||
          container.querySelector('.VwiC3b') ||
          container.querySelector('span.st') ||
          container.querySelector('[data-content-feature]') ||
          container.querySelector('div[style] > span');
        items.push({ title: h3.innerText.trim(), url: href, snippet: snippetEl ? snippetEl.innerText.trim() : '' });
        if (items.length >= 15) break;
      }

      if (items.length === 0) {
        document.querySelectorAll('h3').forEach(h3 => {
          const a = h3.closest('a') || h3.querySelector('a') || h3.parentElement?.querySelector('a');
          if (!a) return;
          const href = a.getAttribute('href') || '';
          if (!href.startsWith('http') || seen.has(href)) return;
          seen.add(href);
          items.push({ title: h3.innerText.trim(), url: href, snippet: '' });
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
        engine: 'google',
      }))
      .slice(0, limit);
  });
}

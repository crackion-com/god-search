import { withBrowserPage } from './browser.js';
import { SEARCH_CONFIG } from './config.js';

export async function extractPage(url) {
  return withBrowserPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SEARCH_CONFIG.extractTimeoutMs });

    return page.evaluate((maxChars) => {
      const removeSelectors = [
        'script', 'style', 'noscript', 'iframe',
        'nav', 'header', 'footer',
        '.ads', '.ad', '[class*="cookie"]', '[id*="cookie"]',
        '[class*="banner"]', '[class*="popup"]', '[class*="modal"]',
        '[class*="sidebar"]', '[class*="navigation"]',
        'aside', '.social-share', '.newsletter',
      ];
      for (const sel of removeSelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      const mainEl =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('.content, .main-content, .post-content, .article-content') ||
        document.body;

      const text = (mainEl?.innerText ?? document.body.innerText)
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxChars);

      return { url: location.href, title: document.title.trim(), content: text, wordCount: text.split(/\s+/).filter(Boolean).length };
    }, SEARCH_CONFIG.maxContentChars);
  });
}

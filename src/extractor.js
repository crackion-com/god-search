import { withBrowserPage } from './browser.js';

const MAX_CONTENT_CHARS = 50_000;
const TIMEOUT_MS = 15000;

export async function extractPage(url) {
  return withBrowserPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

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
    }, MAX_CONTENT_CHARS);
  });
}

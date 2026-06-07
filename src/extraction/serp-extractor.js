import { classifySearchPage } from './page-classifier.js';
import { normalizeResultUrl } from './url-normalize.js';
import { scoreResultCandidate } from './result-confidence.js';

const MODES = ['primary', 'semantic', 'heuristic', 'fallback'];
const MODE_PRIORITY = new Map(MODES.map((mode, index) => [mode, index]));

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeConfig(config = {}) {
  return {
    engine: config.engine || '',
    query: config.query || '',
    limit: Number.isFinite(config.limit) && config.limit > 0 ? Math.floor(config.limit) : 10,
    primarySelectors: config.primarySelectors || {},
    engineHostnames: toArray(config.engineHostnames),
    redirectRules: toArray(config.redirectRules),
    adSignals: toArray(config.adSignals),
    noResultSignals: toArray(config.noResultSignals),
    blockedSignals: toArray(config.blockedSignals),
    consentSignals: toArray(config.consentSignals),
    baseUrl: config.baseUrl || config.url || '',
  };
}

function extractionBudget(limit) {
  return Math.max(15, Math.min(60, limit * 6));
}

function isStrongEnough(results, limit) {
  return results.length >= limit;
}

function pageConfidence(results, classification) {
  if (!results.length) return classification.confidence || 0;
  const top = results.slice(0, Math.min(5, results.length));
  const avg = top.reduce((sum, result) => sum + result.confidence, 0) / top.length;
  return Number(Math.max(0, Math.min(1, avg)).toFixed(3));
}

function statusForResults(results, classification, limit) {
  if (classification.status === 'blocked' || classification.status === 'consent' || classification.status === 'failed') {
    return classification.status;
  }
  if (!results.length) return 'empty';
  if (results.length < Math.min(3, limit) || pageConfidence(results, classification) < 0.45) return 'partial';
  return 'ok';
}

function modeFromResults(results) {
  if (!results.length) return 'fallback';
  return results.reduce((best, result) => {
    const bestPriority = MODE_PRIORITY.get(best) ?? 99;
    const resultPriority = MODE_PRIORITY.get(result.extractionMode) ?? 99;
    return resultPriority < bestPriority ? result.extractionMode : best;
  }, 'fallback');
}

async function runDomExtraction(page, mode, config, budget) {
  return page.evaluate((input) => {
    const MAX_TEXT = 500;

    function array(value) {
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    }

    function textOf(element, maxLength = MAX_TEXT) {
      return (element?.innerText || element?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
    }

    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) === 0) return false;
      if (rect.width > 0 && rect.height > 0) return true;

      // Some SERPs render title anchors with zero-sized inline boxes while the
      // heading or card around them has visible geometry. Treat those as visible
      // if the element still has meaningful text and a visible ancestor.
      if (!textOf(element, 160)) return false;
      const visibleAncestor = element.closest('h1, h2, h3, article, li, section, div, main, [role="main"]');
      if (!visibleAncestor || visibleAncestor === element) return false;
      const ancestorRect = visibleAncestor.getBoundingClientRect();
      const ancestorStyle = getComputedStyle(visibleAncestor);
      return ancestorRect.width > 0 &&
        ancestorRect.height > 0 &&
        ancestorStyle.visibility !== 'hidden' &&
        ancestorStyle.display !== 'none' &&
        Number(ancestorStyle.opacity || 1) !== 0;
    }

    function selectorList(value) {
      if (Array.isArray(value)) return value.filter(Boolean);
      if (typeof value === 'string') return [value];
      return [];
    }

    function first(container, selectors) {
      for (const selector of selectorList(selectors)) {
        try {
          const found = container.querySelector(selector);
          if (found) return found;
        } catch {
          // Ignore bad engine-provided selector hints.
        }
      }
      return null;
    }

    function all(selectors, root = document) {
      const found = [];
      for (const selector of selectorList(selectors)) {
        try {
          found.push(...root.querySelectorAll(selector));
        } catch {
          // Ignore bad engine-provided selector hints.
        }
      }
      return found;
    }

    function blockFor(element) {
      return element?.closest('article, li, section, div, main, [role="main"]') || element;
    }

    function nearestSnippet(container, link, titleElement) {
      const snippetSelectors = [
        ...array(input.primarySelectors?.snippet),
        ...array(input.primarySelectors?.description),
        ...array(input.primarySelectors?.snippetSelector),
        '.snippet',
        '.result__snippet',
        '.b_caption p',
        '[class*="snippet" i]',
        '[class*="description" i]',
        '[data-sncf]',
        'p',
      ];
      const explicit = first(container, snippetSelectors);
      if (explicit && explicit !== link && explicit !== titleElement) return textOf(explicit, 320);

      const text = textOf(container, 700);
      const title = textOf(titleElement || link, 220);
      return text.replace(title, '').trim().slice(0, 320);
    }

    function elementSignals(container, link) {
      const rect = link?.getBoundingClientRect?.() || { width: 0, height: 0 };
      const containerText = textOf(container, 700);
      const classAndId = `${container?.id || ''} ${container?.className || ''}`;
      return {
        anchorArea: Math.round(rect.width * rect.height),
        containerTextLength: containerText.length,
        containerText: containerText.slice(0, 220),
        hasHeading: !!container?.querySelector?.('h1, h2, h3'),
        hasResultClass: /result|algo|web|organic|serp|g\b/i.test(classAndId),
        hidden: !isVisible(link),
        inMain: !!container?.closest?.('main'),
        inArticle: !!container?.closest?.('article'),
        inRoleMain: !!container?.closest?.('[role="main"]'),
        inNav: !!container?.closest?.('nav, [role="navigation"]'),
        inFooter: !!container?.closest?.('footer'),
        inHeader: !!container?.closest?.('header'),
        inAside: !!container?.closest?.('aside, [class*="sidebar" i]'),
        isAd: !!container?.closest?.('[data-text-ad], [aria-label*="sponsored" i], [class="ad" i], [class*=" ad" i], [class$="ad" i], [class*="sponsored" i]') || /\b(ad|ads|advertisement|sponsored|promoted)\b/i.test(containerText),
        isPagination: !!container?.closest?.('[aria-label*="pagination" i], [class*="pagination" i]'),
        isSettings: /settings|preferences|tools/i.test(containerText),
        selector: '',
      };
    }

    function candidate(container, link, titleElement, mode, selector, index) {
      if (!link || !isVisible(link)) return null;
      const href = link.getAttribute('href') || '';
      const title = textOf(titleElement || link, 220);
      if (!href || !title) return null;
      const signals = elementSignals(container, link);
      signals.selector = selector || '';
      return {
        title,
        url: href,
        snippet: nearestSnippet(container, link, titleElement),
        sourceRank: index + 1,
        extractionMode: mode,
        signals,
        warnings: [],
      };
    }

    function fromPrimary() {
      const selectors = input.primarySelectors || {};
      const directContainerSelectors = typeof selectors === 'string' || Array.isArray(selectors) ? array(selectors) : [];
      const containerSelectors = [
        ...directContainerSelectors,
        ...array(selectors.result),
        ...array(selectors.results),
        ...array(selectors.resultSelector),
        ...array(selectors.container),
        ...array(selectors.containers),
        ...array(selectors.containerSelector),
        ...array(selectors.item),
        ...array(selectors.items),
      ];
      const titleSelectors = [
        ...array(selectors.title),
        ...array(selectors.heading),
        ...array(selectors.titleSelector),
        ...array(selectors.headingSelector),
        'h1',
        'h2',
        'h3',
        'a[href]',
      ];
      const linkSelectors = [
        ...array(selectors.link),
        ...array(selectors.url),
        ...array(selectors.href),
        ...array(selectors.linkSelector),
        ...array(selectors.urlSelector),
        'a[href]',
      ];

      const containers = containerSelectors.length ? all(containerSelectors) : [];
      const out = [];
      containers.forEach((container, index) => {
        const link = first(container, linkSelectors);
        const title = first(container, titleSelectors) || link;
        const item = candidate(container, link, title, 'primary', containerSelectors.join(', '), index);
        if (item) out.push(item);
      });

      if (!out.length) {
        const directSelectors = [
          ...directContainerSelectors,
          ...array(selectors.link),
          ...array(selectors.url),
          ...array(selectors.title),
        ];
        all(directSelectors).forEach((element, index) => {
          const link = element.matches?.('a[href]') ? element : element.closest?.('a[href]') || element.querySelector?.('a[href]');
          const container = blockFor(element);
          const item = candidate(container, link, element, 'primary', directSelectors.join(', '), index);
          if (item) out.push(item);
        });
      }
      return out;
    }

    function fromSemantic() {
      const selectors = [
        'main article',
        'main li',
        '[role="main"] article',
        '[role="main"] li',
        '[data-testid*="result" i]',
        '[data-type="web"]',
        '.result',
        '.web-result',
        'li.b_algo',
        'div.g',
        'article',
      ];
      const out = [];
      all(selectors).forEach((container, index) => {
        if (!isVisible(container)) return;
        if (container.closest('nav, footer, header, aside, [class*="sidebar" i]')) return;
        const title = first(container, ['h1 a[href], h2 a[href], h3 a[href]', 'h1, h2, h3', 'a[href]']);
        const link = title?.matches?.('a[href]') ? title : title?.closest?.('a[href]') || first(container, ['a[href]']);
        const item = candidate(container, link, title, 'semantic', selectors.join(', '), index);
        if (item) out.push(item);
      });
      return out;
    }

    function fromAnchors(mode) {
      const roots = [
        ...document.querySelectorAll('main, [role="main"], article'),
      ];
      if (!roots.length || mode === 'fallback') roots.push(document.body);

      const seen = new Set();
      const out = [];
      roots.forEach(root => {
        [...root.querySelectorAll('a[href]')].forEach((link) => {
          if (out.length >= input.budget) return;
          if (seen.has(link)) return;
          seen.add(link);
          if (!isVisible(link)) return;
          const container = blockFor(link);
          if (mode !== 'fallback' && container.closest('nav, footer, header, aside, [class*="sidebar" i]')) return;
          const heading = container.querySelector('h1, h2, h3') || link;
          const item = candidate(container, link, heading, mode, 'visible anchors', out.length);
          if (item) out.push(item);
        });
      });
      return out;
    }

    const byMode = {
      primary: fromPrimary,
      semantic: fromSemantic,
      heuristic: () => fromAnchors('heuristic'),
      fallback: () => fromAnchors('fallback'),
    };

    return (byMode[input.mode] || byMode.fallback)().slice(0, input.budget);
  }, {
    mode,
    primarySelectors: config.primarySelectors,
    budget,
  });
}

function finalizeCandidates(rawCandidates, config, limit) {
  const diagnostics = {
    rawCandidates: rawCandidates.length,
    acceptedCandidates: 0,
    rejected: {},
    byMode: Object.fromEntries(MODES.map(mode => [mode, 0])),
  };
  const seen = new Set();
  const accepted = [];

  for (const raw of rawCandidates) {
    diagnostics.byMode[raw.extractionMode] = (diagnostics.byMode[raw.extractionMode] || 0) + 1;
    const normalized = normalizeResultUrl(raw.url, config);
    if (normalized.rejected) {
      diagnostics.rejected[normalized.reason] = (diagnostics.rejected[normalized.reason] || 0) + 1;
      continue;
    }
    if (seen.has(normalized.url)) {
      diagnostics.rejected.duplicate = (diagnostics.rejected.duplicate || 0) + 1;
      continue;
    }

    const candidate = {
      ...raw,
      title: cleanText(raw.title, 220),
      url: normalized.url,
      snippet: cleanText(raw.snippet, 320),
      warnings: [...toArray(raw.warnings), ...normalized.warnings],
      signals: {
        ...(raw.signals || {}),
        url: normalized.signals,
      },
    };
    const scored = scoreResultCandidate(candidate, config);
    if (scored.confidence < 0.25) {
      diagnostics.rejected.lowConfidence = (diagnostics.rejected.lowConfidence || 0) + 1;
      continue;
    }

    seen.add(candidate.url);
    accepted.push({
      title: candidate.title,
      url: candidate.url,
      snippet: candidate.snippet,
      rank: 0,
      confidence: Number(scored.confidence.toFixed(3)),
      extractionMode: candidate.extractionMode,
      signals: {
        ...scored.signals,
        url: normalized.signals,
      },
      warnings: scored.warnings,
      sourceRank: candidate.sourceRank || accepted.length + 1,
    });
  }

  accepted.sort((a, b) => {
    const modeDelta = (MODE_PRIORITY.get(a.extractionMode) ?? 99) - (MODE_PRIORITY.get(b.extractionMode) ?? 99);
    if (modeDelta) return modeDelta;
    const rankDelta = a.sourceRank - b.sourceRank;
    if (rankDelta) return rankDelta;
    return b.confidence - a.confidence;
  });

  const results = accepted.slice(0, limit).map((result, index) => {
    const { sourceRank, ...publicResult } = result;
    return { ...publicResult, rank: index + 1 };
  });

  diagnostics.acceptedCandidates = accepted.length;
  return { results, diagnostics };
}

export async function extractSerpResults(page, config = {}) {
  const safeConfig = sanitizeConfig(config);
  if (!safeConfig.baseUrl && typeof page.url === 'function') {
    safeConfig.baseUrl = page.url();
  }
  try {
    const pageHostname = new URL(safeConfig.baseUrl).hostname;
    if (pageHostname && !safeConfig.engineHostnames.includes(pageHostname)) {
      safeConfig.engineHostnames = [...safeConfig.engineHostnames, pageHostname];
    }
  } catch {
    // A missing page URL only disables relative URL resolution and self-link rejection.
  }
  const limit = safeConfig.limit;
  const budget = extractionBudget(limit);

  const classification = await classifySearchPage(page, safeConfig);
  if (classification.status === 'blocked' || classification.status === 'consent' || classification.status === 'empty' || classification.status === 'failed') {
    return {
      status: classification.status,
      mode: 'fallback',
      confidence: classification.confidence,
      results: [],
      diagnostics: {
        classification,
        candidateCounts: { rawCandidates: 0, acceptedCandidates: 0, rejected: {}, byMode: {} },
      },
    };
  }

  const rawCandidates = [];
  const extractionErrors = [];
  for (const mode of MODES) {
    try {
      const next = await runDomExtraction(page, mode, safeConfig, budget);
      rawCandidates.push(...next);
      if (mode === 'primary') {
        const primaryFinal = finalizeCandidates(next, safeConfig, limit);
        if (isStrongEnough(primaryFinal.results, limit)) break;
      } else {
        const currentFinal = finalizeCandidates(rawCandidates, safeConfig, limit);
        if (isStrongEnough(currentFinal.results, limit)) break;
      }
    } catch (err) {
      extractionErrors.push({ mode, error: String(err?.message || err) });
    }
  }

  const { results, diagnostics: candidateCounts } = finalizeCandidates(rawCandidates, safeConfig, limit);
  const status = classification.status === 'empty' && results.length === 0
    ? 'empty'
    : statusForResults(results, classification, limit);
  const confidence = pageConfidence(results, classification);

  return {
    status,
    mode: modeFromResults(results),
    confidence,
    results,
    diagnostics: {
      classification,
      candidateCounts,
      extractionErrors,
    },
  };
}

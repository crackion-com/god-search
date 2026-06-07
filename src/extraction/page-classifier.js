const DEFAULT_BLOCKED_SIGNALS = [
  'captcha',
  'unusual traffic',
  'verify you are human',
  'checking your browser',
  'access denied',
  'temporarily blocked',
  'too many requests',
  'not a robot',
  'automated queries',
];

const DEFAULT_CONSENT_SIGNALS = [
  'before you continue',
  'we value your privacy',
  'accept all cookies',
  'cookie consent',
  'consent',
  'privacy choices',
];

const DEFAULT_NO_RESULT_SIGNALS = [
  'no results found',
  'did not match any documents',
  'no results for',
  'try different keywords',
  'there are no results',
  'could not find any results',
];

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSignals(signals) {
  return toArray(signals)
    .map(signal => String(signal || '').trim())
    .filter(Boolean);
}

export async function classifySearchPage(page, config = {}) {
  try {
    const result = await page.evaluate((input) => {
      const body = document.body;
      const bodyText = (body?.innerText || '').replace(/\s+/g, ' ').trim();
      const lowerText = bodyText.toLowerCase();
      const title = document.title || '';
      const lowerTitle = title.toLowerCase();
      const text = `${lowerTitle} ${lowerText}`;

      const blockedSignals = input.blockedSignals.filter(signal => text.includes(signal.toLowerCase()));
      const consentSignals = input.consentSignals.filter(signal => text.includes(signal.toLowerCase()));
      const noResultSignals = input.noResultSignals.filter(signal => text.includes(signal.toLowerCase()));

      const blockedSelectors = [
        '#captcha-form',
        '#recaptcha',
        '[class*="captcha" i]',
        '[id*="captcha" i]',
        '.cf-challenge-running',
        'form[action*="Captcha" i]',
      ].filter(selector => document.querySelector(selector));

      const consentSelectors = [
        'form[action*="consent" i]',
        '[id*="consent" i]',
        '[class*="consent" i]',
        '[id*="cookie" i]',
        '[class*="cookie" i]',
        'button[aria-label*="accept" i]',
      ].filter(selector => document.querySelector(selector));

      const resultAnchors = [...document.querySelectorAll('main a[href], [role="main"] a[href], article a[href], li a[href], h2 a[href], h3 a[href]')]
        .filter(anchor => {
          const rect = anchor.getBoundingClientRect();
          const style = getComputedStyle(anchor);
          const href = anchor.getAttribute('href') || '';
          return href && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }).length;

      const weakBlockedSignals = new Set(['robot']);
      const strongBlockedSignals = blockedSignals.filter(signal => !weakBlockedSignals.has(signal.toLowerCase()));
      const challengeContext = /captcha|unusual traffic|verify you are human|not a robot|automated queries|access denied|temporarily blocked/i.test(text);
      const blockedByWeakSignal = blockedSignals.length > strongBlockedSignals.length && resultAnchors === 0 && challengeContext;
      const trueEmpty = noResultSignals.length > 0 && resultAnchors === 0;

      let status = 'ok';
      let confidence = 0.5;
      if (strongBlockedSignals.length || blockedSelectors.length || blockedByWeakSignal) {
        status = 'blocked';
        confidence = 0.95;
      } else if (consentSignals.length >= 2 || (consentSignals.length && resultAnchors === 0) || /consent|privacy|cookie/i.test(location.href)) {
        status = 'consent';
        confidence = 0.85;
      } else if (trueEmpty) {
        status = 'empty';
        confidence = 0.9;
      } else if (!body || bodyText.length < 20) {
        status = 'failed';
        confidence = 0.6;
      }

      const signals = {
        blocked: blockedSignals,
        blockedSelectors,
        consent: consentSignals,
        consentSelectors,
        visibleResultAnchors: resultAnchors,
      };
      if (trueEmpty) signals.noResults = noResultSignals;
      if (noResultSignals.length && !trueEmpty) signals.noResultsWithResults = noResultSignals;

      return {
        status,
        confidence,
        signals,
        diagnostics: {
          title,
          url: location.href,
          bodyTextLength: bodyText.length,
        },
      };
    }, {
      blockedSignals: [
        ...DEFAULT_BLOCKED_SIGNALS,
        ...normalizeSignals(config.blockedSignals),
      ],
      consentSignals: [
        ...DEFAULT_CONSENT_SIGNALS,
        ...normalizeSignals(config.consentSignals),
      ],
      noResultSignals: [
        ...DEFAULT_NO_RESULT_SIGNALS,
        ...normalizeSignals(config.noResultSignals),
      ],
    });

    return result;
  } catch (err) {
    return {
      status: 'failed',
      confidence: 0,
      signals: { error: String(err?.message || err) },
      diagnostics: {},
    };
  }
}

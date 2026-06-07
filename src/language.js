/**
 * language.js - Locale detection, Unicode tokenization, and engine hint helpers.
 */

const DEFAULT_LANGUAGE = 'en';
const DEFAULT_REGIONS = {
  ar: 'SA',
  de: 'DE',
  el: 'GR',
  en: 'US',
  es: 'ES',
  fr: 'FR',
  he: 'IL',
  hi: 'IN',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  nl: 'NL',
  pt: 'BR',
  ru: 'RU',
  th: 'TH',
  tr: 'TR',
  zh: 'CN',
};

const WIKIPEDIA_LANGUAGES = new Set([
  'ar', 'de', 'el', 'en', 'es', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'th', 'tr', 'zh',
]);

const STOP_WORDS = {
  ar: ['في', 'من', 'على', 'عن', 'ما', 'هو', 'هي', 'هذا', 'هذه', 'الى', 'إلى'],
  de: ['der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'und', 'oder', 'mit', 'von', 'für', 'ist', 'wie'],
  en: [
    'a', 'an', 'and', 'any', 'best', 'can', 'compare', 'comparison', 'current',
    'documentation', 'docs', 'find', 'for', 'from', 'give', 'how', 'in', 'into',
    'is', 'just', 'latest', 'like', 'me', 'of', 'official', 'only', 'or',
    'provider', 'providers', 'return', 'short', 'should', 'site', 'source',
    'sources', 'than', 'the', 'then', 'that', 'this', 'url', 'use', 'web',
    'what', 'with', 'your', 'about', 'also', 'to', 'get', 'using', 'via',
  ],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'para', 'con', 'que', 'como', 'cómo'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'de', 'du', 'pour', 'avec', 'que', 'comment'],
  he: ['של', 'על', 'את', 'עם', 'מה', 'זה', 'זו'],
  hi: ['के', 'की', 'का', 'में', 'और', 'क्या', 'है'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'e', 'o', 'di', 'per', 'con', 'che', 'come'],
  ja: ['これ', 'それ', 'ため', '方法'],
  ko: ['그리고', '또는', '에서', '으로', '무엇'],
  nl: ['de', 'het', 'een', 'en', 'of', 'van', 'voor', 'met', 'wat', 'hoe'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'e', 'ou', 'de', 'do', 'da', 'para', 'com', 'que', 'como'],
  ru: ['и', 'или', 'что', 'как', 'для', 'это', 'на', 'в', 'с', 'по'],
  th: ['และ', 'หรือ', 'คือ', 'ใน'],
  tr: ['ve', 'veya', 'bir', 'bu', 'ile', 'için', 'nedir', 'nasıl'],
  zh: ['的', '了', '和', '是', '在', '什么', '如何'],
};

const SCRIPT_PATTERNS = [
  ['ar', /\p{Script=Arabic}/gu],
  ['zh', /\p{Script=Han}/gu],
  ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['ko', /\p{Script=Hangul}/gu],
  ['ru', /\p{Script=Cyrillic}/gu],
  ['he', /\p{Script=Hebrew}/gu],
  ['el', /\p{Script=Greek}/gu],
  ['hi', /\p{Script=Devanagari}/gu],
  ['th', /\p{Script=Thai}/gu],
];

const LATIN_LANGUAGE_SIGNALS = [
  ['es', /[áíóúñ¿¡]|\b(el|la|los|las|del|para|con|que|cómo|como)\b/i],
  ['fr', /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|pour|avec|comment)\b/i],
  ['de', /[äöüß]|\b(der|die|das|und|oder|für|mit|wie|was|ist)\b/i],
  ['pt', /[ãõç]|\b(os|as|para|com|como|não|uma)\b/i],
  ['it', /[àèéìòù]|\b(il|lo|gli|che|come|per|con)\b/i],
  ['tr', /[çğıöşü]|\b(ve|veya|için|nasıl|nedir)\b/i],
  ['nl', /\b(het|een|voor|met|hoe)\b/i],
];

const DDG_REGION_HINTS = new Map([
  ['ar-SA', 'xa-ar'],
  ['de-DE', 'de-de'],
  ['en-CA', 'ca-en'],
  ['en-GB', 'uk-en'],
  ['en-US', 'us-en'],
  ['es-ES', 'es-es'],
  ['es-MX', 'mx-es'],
  ['fr-CA', 'ca-fr'],
  ['fr-FR', 'fr-fr'],
  ['it-IT', 'it-it'],
  ['ja-JP', 'jp-jp'],
  ['ko-KR', 'kr-kr'],
  ['nl-NL', 'nl-nl'],
  ['pt-BR', 'br-pt'],
  ['pt-PT', 'pt-pt'],
  ['ru-RU', 'ru-ru'],
  ['zh-CN', 'cn-zh'],
]);

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function stopWordsFor(language) {
  return new Set([...(STOP_WORDS.en || []), ...(STOP_WORDS[language] || [])]);
}

function normalizeLanguage(value) {
  const match = String(value || '').trim().match(/^[a-z]{2,3}/i);
  return match ? match[0].toLowerCase() : '';
}

function normalizeRegion(value) {
  const match = String(value || '').trim().match(/^([a-z]{2}|\d{3})$/i);
  return match ? match[0].toUpperCase() : '';
}

export function normalizeLocale(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim().replace(/_/g, '-');
  if (!raw) return null;

  const parts = raw.split('-').filter(Boolean);
  const language = normalizeLanguage(parts[0]);
  if (!language) return null;

  let region = '';
  for (const part of parts.slice(1)) {
    region = normalizeRegion(part);
    if (region) break;
  }
  region ||= DEFAULT_REGIONS[language] || DEFAULT_REGIONS[DEFAULT_LANGUAGE];

  return {
    language,
    region,
    locale: `${language}-${region}`,
  };
}

export function detectLanguage(text) {
  const value = String(text || '');
  const letterCount = countMatches(value, /\p{L}/gu);
  if (letterCount === 0) {
    const fallback = normalizeLocale(DEFAULT_LANGUAGE);
    return { ...fallback, confidence: 0, source: 'fallback' };
  }

  let best = { language: DEFAULT_LANGUAGE, count: 0 };
  for (const [language, pattern] of SCRIPT_PATTERNS) {
    const count = countMatches(value, pattern);
    if (count > best.count) best = { language, count };
  }
  if (best.count >= 2 || best.count / letterCount >= 0.2) {
    const locale = normalizeLocale(best.language);
    return { ...locale, confidence: Math.min(1, best.count / letterCount), source: 'script' };
  }

  for (const [language, pattern] of LATIN_LANGUAGE_SIGNALS) {
    if (pattern.test(value)) {
      const locale = normalizeLocale(language);
      return { ...locale, confidence: 0.65, source: 'latin-signal' };
    }
  }

  const locale = normalizeLocale(DEFAULT_LANGUAGE);
  return { ...locale, confidence: 0.45, source: 'fallback' };
}

export function localeHints(context = {}) {
  const normalized = normalizeLocale(context.locale) || normalizeLocale(context.language) || normalizeLocale(DEFAULT_LANGUAGE);
  const { language, region, locale } = normalized;
  const wikiLanguage = WIKIPEDIA_LANGUAGES.has(language) ? language : DEFAULT_LANGUAGE;
  return {
    google: {
      hl: language,
      lr: `lang_${language}`,
      gl: region,
    },
    bing: {
      setLang: language,
      cc: region,
      mkt: `${language}-${region}`,
    },
    ddg: {
      kl: DDG_REGION_HINTS.get(locale) || DDG_REGION_HINTS.get(`${language}-${DEFAULT_REGIONS[language] || region}`) || '',
    },
    wikipedia: {
      language: wikiLanguage,
      api: `https://${wikiLanguage}.wikipedia.org/w/api.php`,
      uselang: language,
    },
  };
}

export function buildLanguageContext(query, opts = {}) {
  if (opts.languageContext?.locale && opts.languageContext?.hints) return opts.languageContext;

  const explicit = normalizeLocale(opts.locale || opts.language || opts.lang);
  const detected = detectLanguage(query);
  const selected = explicit || detected || normalizeLocale(DEFAULT_LANGUAGE);
  const hints = localeHints(selected);
  return {
    language: selected.language,
    region: selected.region,
    locale: selected.locale,
    detected_language: detected.language,
    detected_locale: detected.locale,
    detection_confidence: detected.confidence,
    source: explicit ? 'explicit' : detected.source,
    hints,
  };
}

export function normalizeText(text, context = {}) {
  const locale = context.locale || context.language || DEFAULT_LANGUAGE;
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase(locale)
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"');
}

export function keywordTokens(text, context = {}, opts = {}) {
  const language = context.language || normalizeLocale(context.locale)?.language || DEFAULT_LANGUAGE;
  const minLength = opts.minLength ?? 3;
  const stopWords = stopWordsFor(language);
  const normalized = normalizeText(text, context).replace(/["']/g, ' ');
  const tokens = [];

  for (const match of normalized.matchAll(TOKEN_RE)) {
    const token = match[0].trim();
    if (!token) continue;
    const hasAsciiLetterOrDigit = /[a-z0-9]/i.test(token);
    if (hasAsciiLetterOrDigit && token.length < minLength) continue;
    if (!hasAsciiLetterOrDigit && token.length < 2) continue;
    if (stopWords.has(token)) continue;
    tokens.push(token);
  }

  return [...new Set(tokens)];
}

export function textIncludesToken(text, token, context = {}) {
  return normalizeText(text, context).includes(token);
}

export function tokenHitCount(tokens, text, context = {}) {
  const normalized = normalizeText(text, context);
  return tokens.reduce((count, token) => count + (normalized.includes(token) ? 1 : 0), 0);
}

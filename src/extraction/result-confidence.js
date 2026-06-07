const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'by', 'can', 'for', 'from',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'search', 'the', 'this', 'to',
  'with', 'what', 'when', 'where', 'why',
]);

const TITLE_NOISE = /^(cached|similar|translate|images|videos|news|maps|shopping|settings|tools|more|next|previous)$/i;
const URL_NOISE_PATH = /\/(search|settings|preferences|login|signin|signup|privacy|terms|account)(\/|$)/i;
const TEXT_AD_SIGNAL = /\b(ad|ads|advertisement|sponsored|promoted)\b/i;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function unique(value) {
  return [...new Set(value)];
}

function queryOverlap(query, haystack) {
  const queryTokens = unique(tokens(query));
  if (!queryTokens.length) return 0;
  const lower = String(haystack || '').toLowerCase();
  const matched = queryTokens.filter(token => lower.includes(token)).length;
  return matched / queryTokens.length;
}

function scoreUrl(urlString) {
  try {
    const url = new URL(urlString);
    let score = 0.2;
    const hostname = url.hostname.replace(/^www\./i, '');
    if (hostname.includes('.') && !/\d+\.\d+\.\d+\.\d+/.test(hostname)) score += 0.12;
    if (/^https:$/i.test(url.protocol)) score += 0.04;
    if (url.pathname && url.pathname !== '/') score += 0.08;
    if (!URL_NOISE_PATH.test(url.pathname)) score += 0.08;
    if ([...url.searchParams.keys()].length <= 2) score += 0.05;
    return clamp(score, 0, 0.45);
  } catch {
    return 0;
  }
}

function scoreTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { score: 0, warning: 'missing-title' };
  if (TITLE_NOISE.test(clean)) return { score: 0.02, warning: 'nav-title' };
  let score = 0.08;
  if (clean.length >= 8) score += 0.1;
  if (clean.length >= 18) score += 0.06;
  if (clean.length <= 120) score += 0.04;
  if (/[a-z0-9]/i.test(clean)) score += 0.04;
  return { score: clamp(score, 0, 0.28), warning: '' };
}

function scoreSnippet(snippet) {
  const clean = String(snippet || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  if (clean.length >= 25) return 0.12;
  if (clean.length >= 8) return 0.07;
  return 0.03;
}

function scoreAncestor(candidate) {
  const signals = candidate.signals || {};
  let score = 0;
  if (signals.inMain || signals.inArticle || signals.inRoleMain) score += 0.1;
  if (signals.hasResultClass || signals.hasHeading) score += 0.08;
  if (signals.containerTextLength >= 80) score += 0.05;
  if (signals.anchorArea >= 120) score += 0.03;
  if (signals.inNav || signals.inFooter || signals.inAside || signals.inHeader) score -= 0.2;
  return clamp(score, -0.2, 0.22);
}

function noisePenalty(candidate, config = {}) {
  const signals = candidate.signals || {};
  const text = `${candidate.title || ''} ${candidate.snippet || ''} ${signals.containerText || ''}`;
  let penalty = 0;

  if (signals.inNav || signals.inFooter || signals.inAside || signals.inHeader) penalty += 0.25;
  if (signals.isAd) penalty += 0.55;
  if (signals.isPagination || /\b(next|previous|page \d+)\b/i.test(candidate.title || '')) penalty += 0.2;
  if (signals.isSettings || /\b(settings|preferences|tools)\b/i.test(candidate.title || '')) penalty += 0.2;
  if (signals.hidden) penalty += 0.25;
  if (TEXT_AD_SIGNAL.test(text)) penalty += 0.45;
  try {
    if (/^(ads?|shopping|maps)\./i.test(new URL(candidate.url).hostname)) penalty += 0.4;
  } catch {
    // Invalid URLs already score poorly in urlQuality.
  }

  for (const signal of Array.isArray(config.adSignals) ? config.adSignals : []) {
    if (signal && text.toLowerCase().includes(String(signal).toLowerCase())) {
      penalty += 0.15;
    }
  }

  return clamp(penalty, 0, 0.65);
}

export function scoreResultCandidate(candidate, config = {}) {
  const warnings = [...(candidate.warnings || [])];
  const urlQuality = scoreUrl(candidate.url);
  const titleQuality = scoreTitle(candidate.title);
  const snippetAvailability = scoreSnippet(candidate.snippet);
  const ancestorQuality = scoreAncestor(candidate);
  const overlap = queryOverlap(config.query, `${candidate.title || ''} ${candidate.snippet || ''} ${candidate.url || ''}`);
  const overlapScore = overlap * 0.18;
  const penalty = noisePenalty(candidate, config);

  if (titleQuality.warning) warnings.push(titleQuality.warning);
  if (!snippetAvailability) warnings.push('missing-snippet');
  if (penalty >= 0.25) warnings.push('noise-penalty');

  const raw = urlQuality + titleQuality.score + snippetAvailability + ancestorQuality + overlapScore - penalty;
  const confidence = clamp(raw);

  return {
    confidence,
    signals: {
      urlQuality,
      titleQuality: titleQuality.score,
      snippetAvailability,
      ancestorQuality,
      queryOverlap: overlap,
      noisePenalty: penalty,
      rawScore: raw,
    },
    warnings: unique(warnings),
  };
}

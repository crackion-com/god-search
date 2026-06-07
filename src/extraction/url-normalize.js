const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_/i,
  /^pk_/i,
  /^yclid$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^spm$/i,
  /^ved$/i,
  /^ei$/i,
  /^sa$/i,
  /^source$/i,
];

const ENGINE_HOSTNAMES = {
  google: ['google.com', 'www.google.com', 'googleusercontent.com'],
  ddg: ['duckduckgo.com', 'html.duckduckgo.com', 'www.duckduckgo.com'],
  duckduckgo: ['duckduckgo.com', 'html.duckduckgo.com', 'www.duckduckgo.com'],
  bing: ['bing.com', 'www.bing.com'],
  brave: ['search.brave.com', 'brave.com'],
};

const NAVIGATION_PATHS = [
  /^\/search\/?$/i,
  /^\/(settings|preferences|account|login|signin|signup|register)(\/|$)/i,
  /^\/(advanced_search|images|videos|news|maps|shopping|travel|flights)(\/|$)/i,
  /^\/(privacy|terms|help|support|about|contact|feedback)(\/|$)/i,
];

const NAVIGATION_QUERY_PARAMS = [
  'q',
  'query',
  'search',
  'setlang',
  'form',
  'first',
  'start',
  'count',
  'num',
];

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hostnameMatches(hostname, pattern, { includeSubdomains = true } = {}) {
  const normalized = String(pattern || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!normalized) return false;
  return hostname === normalized || (includeSubdomains && hostname.endsWith(`.${normalized}`));
}

function knownEngineHostnames(engine) {
  return ENGINE_HOSTNAMES[String(engine || '').toLowerCase()] || [];
}

export function engineHostnames(config = {}) {
  return [
    ...knownEngineHostnames(config.engine),
    ...toArray(config.engineHostnames),
  ].filter(Boolean);
}

export function isEngineSelfLink(urlString, config = {}) {
  try {
    const hostname = new URL(urlString).hostname.replace(/^www\./i, '').toLowerCase();
    return engineHostnames(config).some(host => hostnameMatches(hostname, host, { includeSubdomains: false }));
  } catch {
    return false;
  }
}

function safeDecode(value) {
  let decoded = String(value || '');
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function decodeBase64Url(value) {
  const input = String(value || '').trim();
  const candidates = [
    input,
    input.replace(/^a\d/i, ''),
    input.slice(2),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf8').replace(/\0/g, '').trim();
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // Try the next common Bing encoding shape.
    }
  }
  return '';
}

function unwrapWithRules(url, redirectRules = []) {
  for (const rule of toArray(redirectRules)) {
    if (!rule || typeof rule !== 'object') continue;
    const hostPatterns = toArray(rule.hostname || rule.host || rule.hostnames);
    const pathPattern = rule.path ? new RegExp(rule.path, rule.flags || 'i') : null;
    const paramNames = toArray(rule.param || rule.params || rule.queryParam);

    if (hostPatterns.length && !hostPatterns.some(host => hostnameMatches(url.hostname, host))) continue;
    if (pathPattern && !pathPattern.test(url.pathname)) continue;

    for (const param of paramNames) {
      const raw = url.searchParams.get(param);
      if (!raw) continue;
      if (rule.encoding === 'base64url') {
        const decoded = decodeBase64Url(raw);
        if (decoded) return decoded;
      }
      const decoded = safeDecode(raw);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  }
  return '';
}

function unwrapKnownRedirect(url, config = {}) {
  const custom = unwrapWithRules(url, config.redirectRules);
  if (custom) return custom;

  const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
  const pathname = url.pathname || '/';

  if (hostname.endsWith('google.com') && pathname === '/url') {
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    if (target) return safeDecode(target);
  }

  if (pathname === '/url') {
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    const decoded = safeDecode(target);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }

  if (hostname.endsWith('duckduckgo.com')) {
    const target = url.searchParams.get('uddg');
    if (target) return safeDecode(target);
  }

  if (hostname.endsWith('bing.com') && pathname.startsWith('/ck/a')) {
    const encoded = url.searchParams.get('u');
    const decoded = decodeBase64Url(encoded);
    if (decoded) return decoded;
  }

  return '';
}

function removeTrackingParams(url) {
  const params = [...url.searchParams.keys()];
  for (const key of params) {
    if (TRACKING_PARAMS.some(pattern => pattern.test(key))) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
}

function isNavigationPath(url) {
  const path = url.pathname || '/';
  if (NAVIGATION_PATHS.some(pattern => pattern.test(path))) return true;
  const queryKeys = [...url.searchParams.keys()].map(key => key.toLowerCase());
  if (path === '/' && queryKeys.some(key => NAVIGATION_QUERY_PARAMS.includes(key))) return true;
  return false;
}

export function normalizeResultUrl(rawUrl, config = {}) {
  const warnings = [];
  const signals = {
    unwrapped: false,
    strippedTracking: false,
    hadHash: false,
  };

  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: '', rejected: true, reason: 'missing-url', warnings, signals };
  }

  const trimmed = rawUrl.trim();
  if (/^(mailto|javascript|tel|data):/i.test(trimmed) || trimmed.startsWith('#')) {
    return { url: '', rejected: true, reason: 'unsupported-protocol', warnings, signals };
  }

  let url;
  try {
    url = new URL(trimmed, config.baseUrl || undefined);
  } catch {
    return { url: '', rejected: true, reason: 'invalid-url', warnings, signals };
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return { url: '', rejected: true, reason: 'unsupported-protocol', warnings, signals };
  }

  const unwrapped = unwrapKnownRedirect(url, config);
  if (unwrapped && unwrapped !== url.toString()) {
    signals.unwrapped = true;
    warnings.push('redirect-unwrapped');
    try {
      url = new URL(unwrapped);
    } catch {
      return { url: '', rejected: true, reason: 'invalid-unwrapped-url', warnings, signals };
    }
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return { url: '', rejected: true, reason: 'unsupported-protocol', warnings, signals };
  }

  if (isEngineSelfLink(url.toString(), config)) {
    return { url: '', rejected: true, reason: 'engine-self-link', warnings, signals };
  }

  if (url.hash) {
    signals.hadHash = true;
    url.hash = '';
  }

  const beforeParams = url.search;
  removeTrackingParams(url);
  if (beforeParams !== url.search) {
    signals.strippedTracking = true;
    warnings.push('tracking-params-stripped');
  }

  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  if (isNavigationPath(url)) {
    return { url: '', rejected: true, reason: 'navigation-url', warnings, signals };
  }

  return {
    url: url.toString(),
    rejected: false,
    reason: '',
    warnings,
    signals,
  };
}

export function registrableDomain(urlString) {
  try {
    const hostname = new URL(urlString).hostname.replace(/^www\./i, '').toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length < 2) return hostname;
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

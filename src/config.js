import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function readIntEnv(name, fallback, { min = undefined, max = undefined } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  if (min != null && value < min) return fallback;
  if (max != null && value > max) return fallback;
  return value;
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readStringEnv(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw === '' ? fallback : String(raw);
}

export const APP = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
};

export const HTTP_CONFIG = {
  host: readStringEnv('GOD_SEARCH_HOST', '127.0.0.1'),
  port: readIntEnv('GOD_SEARCH_PORT', 3847, { min: 1, max: 65535 }),
};

export const CACHE_CONFIG = {
  ttlMs: readIntEnv('GOD_SEARCH_CACHE_TTL_MS', 10 * 60 * 1000, { min: 1000 }),
  maxEntries: readIntEnv('GOD_SEARCH_CACHE_MAX_ENTRIES', 256, { min: 1 }),
};

export const BROWSER_CONFIG = {
  maxNav: readIntEnv('GOD_SEARCH_MAX_NAV', 2, { min: 1 }),
  prewarmOnStart: readBoolEnv('GOD_SEARCH_PREWARM_BROWSER', false),
};

export const SEARCH_CONFIG = {
  fastPathMs: readIntEnv('GOD_SEARCH_FAST_PATH_MS', 1600, { min: 100 }),
  fastPathMaxMs: readIntEnv('GOD_SEARCH_FAST_PATH_MAX_MS', 1900, { min: 500 }),
  fastPathPollMs: readIntEnv('GOD_SEARCH_FAST_PATH_POLL_MS', 100, { min: 25 }),
  fastPathMinEngines: readIntEnv('GOD_SEARCH_FAST_PATH_MIN_ENGINES', 4, { min: 1, max: 8 }),
  searchTimeoutMs: readIntEnv('GOD_SEARCH_SEARCH_TIMEOUT_MS', 10000, { min: 1000 }),
  apiTimeoutMs: readIntEnv('GOD_SEARCH_API_TIMEOUT_MS', 8000, { min: 1000 }),
  extractTimeoutMs: readIntEnv('GOD_SEARCH_EXTRACT_TIMEOUT_MS', 15000, { min: 1000 }),
  maxContentChars: readIntEnv('GOD_SEARCH_MAX_CONTENT_CHARS', 50_000, { min: 1000 }),
  enableBraveByDefault: readBoolEnv('GOD_SEARCH_ENABLE_BRAVE', false),
  braveMode: readStringEnv('GOD_SEARCH_BRAVE_MODE', 'auto').toLowerCase(),
  braveApiKey: readStringEnv('BRAVE_SEARCH_API_KEY', ''),
  braveApiCountry: readStringEnv('GOD_SEARCH_BRAVE_COUNTRY', 'us'),
  braveApiSearchLang: readStringEnv('GOD_SEARCH_BRAVE_SEARCH_LANG', 'en'),
  githubToken: readStringEnv('GITHUB_TOKEN', ''),
};

export const REDDIT_CONFIG = {
  clientId: readStringEnv('REDDIT_CLIENT_ID', ''),
  clientSecret: readStringEnv('REDDIT_CLIENT_SECRET', ''),
  userAgent: readStringEnv('REDDIT_USER_AGENT', 'god-search/1.0 (research tool; github.com/crackion-com/god-search)'),
};

export const AGENT_CONFIG = {
  exposeGodHealthTool: readBoolEnv('GOD_SEARCH_MCP_HEALTH_TOOL', true),
};

export function publicConfig() {
  return {
    app: APP,
    http: HTTP_CONFIG,
    cache: CACHE_CONFIG,
    browser: BROWSER_CONFIG,
    search: SEARCH_CONFIG,
    agent: AGENT_CONFIG,
  };
}

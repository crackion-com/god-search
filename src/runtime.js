import { APP, publicConfig } from './config.js';

const startedAt = new Date().toISOString();
const runtime = {
  app: APP,
  startedAt,
  requests: {
    search: 0,
    extract: 0,
    health: 0,
  },
  lastSearchAt: null,
  lastExtractAt: null,
  lastSearchMs: null,
  lastExtractMs: null,
  lastSearchQuery: null,
  lastExtractUrl: null,
  lastError: null,
  engineFailures: {},
};

function isoNow() {
  return new Date().toISOString();
}

export function noteHealthRequest() {
  runtime.requests.health += 1;
}

export function noteSearchStart(query) {
  runtime.requests.search += 1;
  runtime.lastSearchAt = isoNow();
  runtime.lastSearchQuery = query;
}

export function noteSearchComplete({ elapsedMs = null, engineErrors = {} } = {}) {
  runtime.lastSearchMs = elapsedMs;
  for (const [engine, error] of Object.entries(engineErrors)) {
    runtime.engineFailures[engine] = {
      error,
      at: isoNow(),
    };
  }
}

export function noteExtractStart(url) {
  runtime.requests.extract += 1;
  runtime.lastExtractAt = isoNow();
  runtime.lastExtractUrl = url;
}

export function noteExtractComplete({ elapsedMs = null } = {}) {
  runtime.lastExtractMs = elapsedMs;
}

export function noteError(scope, error) {
  runtime.lastError = {
    scope,
    message: error?.message || String(error),
    at: isoNow(),
  };
}

export function runtimeSnapshot(extra = {}) {
  return {
    ...runtime,
    config: publicConfig(),
    ...extra,
  };
}

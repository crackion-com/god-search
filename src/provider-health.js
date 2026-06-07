const DEFAULT_COOLDOWN_MS = 30_000;
const RETRY_COOLDOWNS_MS = {
  empty_suspect: 1_000,
  failed: 0,
};

const STATES = new Set([
  'healthy',
  'cooldown',
  'blocked',
  'rate_limited',
  'auth_missing',
  'auth_failed',
  'empty_suspect',
  'failed',
]);

const _providers = new Map();

function now() {
  return Date.now();
}

function defaultState(name) {
  return {
    engine: name,
    state: 'healthy',
    reason: '',
    retry_after_ms: 0,
    last_success_at: null,
    last_failure_at: null,
    failures: 0,
  };
}

function stateFor(name) {
  if (!_providers.has(name)) _providers.set(name, defaultState(name));
  return _providers.get(name);
}

export function classifyProviderError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  if (err?.state === 'cooldown' || err?.code === 'cooldown' || message.includes('cooldown') || message.includes('cooling down')) return 'cooldown';
  if (err?.state && STATES.has(err.state)) return err.state;
  if (err?.code && STATES.has(err.code)) return err.code;
  if (message.includes('captcha') || message.includes('challenge') || message.includes('blocked')) return 'blocked';
  if (message.includes('rate limit') || message.includes('rate_limited') || message.includes('429')) return 'rate_limited';
  if (message.includes('auth_missing') || message.includes('api key') || message.includes('token') && message.includes('not set')) return 'auth_missing';
  if (message.includes('authentication failed') || message.includes('401') || message.includes('403')) return 'auth_failed';
  if (message.includes('empty_suspect') || message.includes('selector_miss') || message.includes('0 results')) return 'empty_suspect';
  return 'failed';
}

export function providerSnapshot(name) {
  const state = stateFor(name);
  const remaining = state.retryUntil ? Math.max(0, state.retryUntil - now()) : 0;
  if (remaining <= 0 && state.state === 'cooldown') {
    state.state = 'healthy';
    state.reason = '';
    state.retryUntil = 0;
    state.retry_after_ms = 0;
  } else {
    state.retry_after_ms = remaining;
  }

  return {
    engine: state.engine,
    state: state.state,
    reason: state.reason,
    retry_after_ms: state.retry_after_ms,
    last_success_at: state.last_success_at,
    last_failure_at: state.last_failure_at,
    failures: state.failures,
  };
}

export function providerCanRun(name) {
  const state = providerSnapshot(name);
  return state.retry_after_ms <= 0 && !['cooldown', 'blocked', 'rate_limited', 'auth_missing', 'auth_failed'].includes(state.state);
}

export function recordProviderSuccess(name) {
  const state = stateFor(name);
  state.state = 'healthy';
  state.reason = '';
  state.retryUntil = 0;
  state.retry_after_ms = 0;
  state.last_success_at = new Date(now()).toISOString();
  state.failures = 0;
  return providerSnapshot(name);
}

export function recordProviderFailure(name, err, opts = {}) {
  const state = stateFor(name);
  const classified = opts.state || classifyProviderError(err);
  const explicitRetryAfterMs = Number(err?.retry_after_ms ?? err?.retryAfterMs);
  const cooldownMs = opts.cooldownMs
    ?? (Number.isFinite(explicitRetryAfterMs) && explicitRetryAfterMs > 0 ? explicitRetryAfterMs : null)
    ?? RETRY_COOLDOWNS_MS[classified]
    ?? DEFAULT_COOLDOWN_MS;
  const retryable = ['cooldown', 'blocked', 'rate_limited', 'auth_missing', 'auth_failed', 'empty_suspect'].includes(classified);

  state.state = STATES.has(classified) ? classified : 'failed';
  state.reason = String(err?.message || err || state.state);
  state.last_failure_at = new Date(now()).toISOString();
  state.failures += 1;
  state.retryUntil = retryable ? now() + cooldownMs : 0;
  state.retry_after_ms = retryable ? cooldownMs : 0;

  return providerSnapshot(name);
}

export function buildProviderHealth(names = []) {
  return Object.fromEntries(names.map(name => [name, providerSnapshot(name)]));
}

export function __resetProviderHealthForTests() {
  _providers.clear();
}

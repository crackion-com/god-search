export class ProviderError extends Error {
  constructor(message, {
    provider,
    code = 'failed',
    state = code,
    status = null,
    retryAfterMs = 0,
    retryable = false,
    degradation = false,
  } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.state = state;
    this.status = status;
    this.retry_after_ms = retryAfterMs;
    this.retryable = retryable;
    this.degradation = degradation;
  }
}

export function providerError(message, metadata = {}) {
  return new ProviderError(message, metadata);
}

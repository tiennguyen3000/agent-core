/**
 * Provider error contract.
 *
 * Invariant 7: every failure leaves the provider as a stable machine code, and
 * invariant 9: no message may contain a secret. `redactSecret` is applied to
 * every string that originates from a remote response or a caught error.
 */

export const ProviderErrorCode = {
  Auth: 'E_AUTH',
  BadRequest: 'E_BAD_REQUEST',
  ModelNotFound: 'E_MODEL_NOT_FOUND',
  ContextOverflow: 'E_CONTEXT_OVERFLOW',
  RateLimited: 'E_RATE_LIMITED',
  Server: 'E_SERVER',
  Network: 'E_NETWORK',
  Timeout: 'E_TIMEOUT',
  BadStream: 'E_BAD_STREAM',
  Cancelled: 'E_CANCELLED',
} as const;

export type ProviderErrorCodeValue = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

export interface ProviderErrorOptions {
  readonly status?: number;
  /** Whether the same request may be attempted again as-is. */
  readonly retryable?: boolean;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCodeValue;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCodeValue, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** 429 and 5xx are worth another attempt; 4xx is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Replaces every occurrence of the credential so it can never reach a log. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return text;
  }
  return text.split(secret).join('***');
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

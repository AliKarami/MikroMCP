// ---------------------------------------------------------------------------
// MikroMCP - Retry engine with exponential backoff and jitter
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries: number;
  /** Base delay in milliseconds before first retry (default 200). */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default 5000). */
  maxDelayMs: number;
}

const DEFAULTS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

/** Network error codes that warrant a retry. */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

/**
 * Determine whether an error is safe to retry.
 *
 * - Network errors identified by `code` property are retryable.
 * - HTTP 5xx responses (identified by `statusCode` >= 500) are retryable.
 * - HTTP 4xx (client errors) are NEVER retried.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    // Network-level error codes
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_CODES.has(code)) {
      return true;
    }

    // HTTP status codes (e.g. from HttpError)
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode >= 500;
    }
  }
  return false;
}

/**
 * Execute `fn` with automatic retries using exponential backoff + jitter.
 *
 * ```
 * delay = min(baseDelay * 2^attempt + random_jitter, maxDelay)
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // If this was the last attempt or the error is not retryable, bail out.
      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const exponentialDelay = opts.baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * opts.baseDelayMs;
      const delay = Math.min(exponentialDelay + jitter, opts.maxDelayMs);

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should not reach here, but satisfy TypeScript.
  throw lastError;
}

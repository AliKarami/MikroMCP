// ---------------------------------------------------------------------------
// MikroMCP - Error enrichment
// ---------------------------------------------------------------------------

import { ErrorCategory, MikroMCPError } from "./error-types.js";
import type { Recoverability } from "./error-types.js";

interface EnrichContext {
  routerId?: string;
  tool?: string;
  path?: string;
}

// Network error codes that indicate the router is unreachable.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/**
 * Default recoverability hints keyed by error category.
 */
function defaultRecoverability(category: ErrorCategory): Recoverability {
  switch (category) {
    case ErrorCategory.VALIDATION:
      return {
        retryable: false,
        suggestedAction: "Check the request parameters and correct any invalid values.",
      };
    case ErrorCategory.NOT_FOUND:
      return {
        retryable: false,
        suggestedAction: "Verify the resource identifier exists on the router.",
      };
    case ErrorCategory.CONFLICT:
      return {
        retryable: false,
        suggestedAction: "Resolve the conflicting state before retrying.",
      };
    case ErrorCategory.PERMISSION_DENIED:
      return {
        retryable: false,
        suggestedAction: "Ensure the identity has sufficient permissions.",
      };
    case ErrorCategory.APPROVAL_REQUIRED:
      return {
        retryable: false,
        suggestedAction: "Request approval from an administrator before retrying.",
      };
    case ErrorCategory.ROUTER_UNREACHABLE:
      return {
        retryable: true,
        retryAfterMs: 5000,
        suggestedAction: "Check network connectivity to the router and retry.",
      };
    case ErrorCategory.ROUTER_AUTH_FAILED:
      return {
        retryable: false,
        suggestedAction: "Verify the router credentials are correct.",
      };
    case ErrorCategory.ROUTER_TIMEOUT:
      return {
        retryable: true,
        retryAfterMs: 3000,
        suggestedAction: "The router did not respond in time. Retry with a longer timeout or check router load.",
      };
    case ErrorCategory.ROUTER_ERROR:
      return {
        retryable: true,
        retryAfterMs: 2000,
        suggestedAction: "The router returned a server error. Retry or check the router logs.",
      };
    case ErrorCategory.ROUTER_BUSY:
      return {
        retryable: true,
        retryAfterMs: 5000,
        suggestedAction: "The router is busy. Wait and retry.",
      };
    case ErrorCategory.INTERNAL:
      return {
        retryable: false,
        suggestedAction: "An unexpected internal error occurred. Check the server logs.",
      };
    case ErrorCategory.CONFIGURATION:
      return {
        retryable: false,
        suggestedAction: "Review the server configuration for errors.",
      };
  }
}

/**
 * Map an HTTP status code to an error category.
 */
function categoryFromStatus(statusCode: number): ErrorCategory {
  if (statusCode === 400) return ErrorCategory.VALIDATION;
  if (statusCode === 401 || statusCode === 403) return ErrorCategory.ROUTER_AUTH_FAILED;
  if (statusCode === 404) return ErrorCategory.NOT_FOUND;
  if (statusCode === 408 || statusCode === 504) return ErrorCategory.ROUTER_TIMEOUT;
  if (statusCode === 409) return ErrorCategory.CONFLICT;
  if (statusCode === 429) return ErrorCategory.ROUTER_BUSY;
  if (statusCode >= 500) return ErrorCategory.ROUTER_ERROR;
  return ErrorCategory.INTERNAL;
}

/**
 * Build a details record that includes optional context fields.
 */
function buildDetails(
  base: Record<string, unknown> | undefined,
  context?: EnrichContext,
): Record<string, unknown> | undefined {
  if (!context?.routerId && !context?.tool && !context?.path && !base) {
    return undefined;
  }
  const details: Record<string, unknown> = { ...base };
  if (context?.routerId) details.routerId = context.routerId;
  if (context?.tool) details.tool = context.tool;
  if (context?.path) details.path = context.path;
  return details;
}

/**
 * Enrich an unknown thrown value into a structured MikroMCPError.
 *
 * - If the value is already a MikroMCPError it is returned unchanged.
 * - HTTP-style errors (with a numeric `statusCode`) are mapped by status.
 * - Network errors (ECONNREFUSED, etc.) become ROUTER_UNREACHABLE.
 * - Everything else becomes INTERNAL.
 */
export function enrichError(
  error: unknown,
  context?: EnrichContext,
): MikroMCPError {
  // Already enriched - pass through.
  if (error instanceof MikroMCPError) {
    return error;
  }

  const raw = error as Record<string, unknown> | null | undefined;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof raw === "object" && raw !== null && typeof raw.message === "string"
        ? (raw.message as string)
        : String(error);

  // --- HTTP-style errors (e.g. undici responses) ---
  if (typeof raw === "object" && raw !== null && typeof raw.statusCode === "number") {
    const statusCode = raw.statusCode as number;
    const category = categoryFromStatus(statusCode);
    return new MikroMCPError({
      category,
      code: `HTTP_${statusCode}`,
      message: rawMessage || `HTTP error ${statusCode}`,
      details: buildDetails({ statusCode }, context),
      recoverability: defaultRecoverability(category),
      cause: error,
    });
  }

  // --- Network errors ---
  const errorCode =
    typeof raw === "object" && raw !== null && typeof raw.code === "string"
      ? (raw.code as string)
      : undefined;

  if (errorCode && UNREACHABLE_CODES.has(errorCode)) {
    const category = ErrorCategory.ROUTER_UNREACHABLE;
    return new MikroMCPError({
      category,
      code: errorCode,
      message: rawMessage || `Network error: ${errorCode}`,
      details: buildDetails({ errorCode }, context),
      recoverability: defaultRecoverability(category),
      cause: error,
    });
  }

  // --- Fallback: INTERNAL ---
  const category = ErrorCategory.INTERNAL;
  return new MikroMCPError({
    category,
    code: "INTERNAL_ERROR",
    message: rawMessage || "An unexpected error occurred",
    details: buildDetails(undefined, context),
    recoverability: defaultRecoverability(category),
    cause: error,
  });
}

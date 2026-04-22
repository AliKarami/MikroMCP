// ---------------------------------------------------------------------------
// MikroMCP - Error taxonomy
// ---------------------------------------------------------------------------

import type { MikroMCPErrorData } from "../../types.js";

export enum ErrorCategory {
  VALIDATION = "VALIDATION",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  APPROVAL_REQUIRED = "APPROVAL_REQUIRED",
  ROUTER_UNREACHABLE = "ROUTER_UNREACHABLE",
  ROUTER_AUTH_FAILED = "ROUTER_AUTH_FAILED",
  ROUTER_TIMEOUT = "ROUTER_TIMEOUT",
  ROUTER_ERROR = "ROUTER_ERROR",
  ROUTER_BUSY = "ROUTER_BUSY",
  INTERNAL = "INTERNAL",
  CONFIGURATION = "CONFIGURATION",
}

export interface Recoverability {
  retryable: boolean;
  retryAfterMs?: number;
  suggestedAction: string;
  alternativeTools?: string[];
}

export interface MikroMCPErrorOptions {
  category: ErrorCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverability: Recoverability;
  cause?: unknown;
}

export class MikroMCPError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly recoverability: Recoverability;

  constructor(options: MikroMCPErrorOptions) {
    super(options.message);
    this.name = "MikroMCPError";
    this.category = options.category;
    this.code = options.code;
    this.details = options.details;
    this.recoverability = options.recoverability;

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /** Serialize to a plain JSON-safe object. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      details: this.details,
      recoverability: this.recoverability,
    };
  }

  /** Convert to the wire-format error data used in DomainResult. */
  toMikroMCPErrorData(): MikroMCPErrorData {
    return {
      category: this.category,
      code: this.code,
      message: this.message,
      details: this.details,
      recoverability: {
        retryable: this.recoverability.retryable,
        retryAfterMs: this.recoverability.retryAfterMs,
        suggestedAction: this.recoverability.suggestedAction,
        alternativeTools: this.recoverability.alternativeTools,
      },
    };
  }
}

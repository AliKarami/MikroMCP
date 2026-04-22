// ---------------------------------------------------------------------------
// MikroMCP - Circuit breaker for router connections
// ---------------------------------------------------------------------------

import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default 5). */
  failureThreshold: number;
  /** Time in ms to wait before transitioning from open to half-open (default 30000). */
  cooldownMs: number;
}

const DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  private currentState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly routerId: string,
    options?: Partial<CircuitBreakerOptions>,
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  get state(): CircuitState {
    // If the circuit is open and the cooldown has elapsed, transition to half-open.
    if (this.currentState === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.options.cooldownMs) {
        this.currentState = "half-open";
      }
    }
    return this.currentState;
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - **closed**: execute normally; track consecutive failures.
   * - **open**: reject immediately with `ROUTER_BUSY`.
   * - **half-open**: execute as a probe; success closes, failure reopens.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers cooldown check

    if (currentState === "open") {
      throw new MikroMCPError({
        category: ErrorCategory.ROUTER_BUSY,
        code: "CIRCUIT_OPEN",
        message: `Circuit breaker is open for router "${this.routerId}". Try again after cooldown.`,
        details: {
          routerId: this.routerId,
          consecutiveFailures: this.consecutiveFailures,
          cooldownMs: this.options.cooldownMs,
        },
        recoverability: {
          retryable: true,
          retryAfterMs: this.options.cooldownMs,
          suggestedAction: "Wait for the circuit breaker cooldown period to expire, then retry.",
        },
      });
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Force the circuit back to the closed state. */
  reset(): void {
    this.currentState = "closed";
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }

  // ---------- internal helpers ----------

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.currentState = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.currentState === "half-open") {
      // Probe failed - reopen.
      this.currentState = "open";
    } else if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.currentState = "open";
    }
  }
}

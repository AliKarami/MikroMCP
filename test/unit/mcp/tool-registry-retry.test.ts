import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../../../src/adapter/circuit-breaker.js";
import { withRetry } from "../../../src/adapter/retry-engine.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

describe("retry/circuit-breaker ordering", () => {
  it("retry attempts do not accumulate circuit breaker failures", async () => {
    const cb = new CircuitBreaker("r1", { failureThreshold: 3, cooldownMs: 30000 });
    let calls = 0;

    const unreachable = new MikroMCPError({
      category: ErrorCategory.ROUTER_UNREACHABLE,
      code: "ECONNREFUSED",
      message: "unreachable",
      recoverability: { retryable: true, suggestedAction: "retry" },
    });

    const handler = async () => {
      calls++;
      throw unreachable;
    };

    // cb.execute wraps withRetry(handler) — should count as ONE failure
    await expect(
      cb.execute(() => withRetry(handler, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 })),
    ).rejects.toThrow();

    // handler was called 3 times (1 + 2 retries), but CB saw only 1 failure
    expect(calls).toBe(3);
    expect(cb.state).toBe("closed"); // threshold is 3, only 1 counted
  });
});

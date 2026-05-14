import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../../../src/adapter/circuit-breaker.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const transientErr = new MikroMCPError({
  category: ErrorCategory.ROUTER_UNREACHABLE,
  code: "ECONNREFUSED",
  message: "unreachable",
  recoverability: { retryable: true, suggestedAction: "retry" },
});

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker("test-router", { failureThreshold: 3, cooldownMs: 100 });
  });

  it("starts in closed state", () => {
    expect(cb.state).toBe("closed");
  });

  it("passes through on success", async () => {
    const result = await cb.execute(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.state).toBe("closed");
  });

  it("opens after consecutive failures reach threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow("unreachable");
    }
    expect(cb.state).toBe("open");
  });

  it("rejects immediately when open", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    }

    await expect(cb.execute(() => Promise.resolve("ok"))).rejects.toThrow(
      "Circuit breaker is open",
    );
  });

  it("transitions to half-open after cooldown", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    }
    expect(cb.state).toBe("open");

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");
  });

  it("closes on success in half-open state", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");

    const result = await cb.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
  });

  it("reopens on failure in half-open state", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");

    await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    expect(cb.state).toBe("open");
  });

  it("resets to closed", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(transientErr))).rejects.toThrow();
    }
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
  });
});

describe("circuit breaker - failure filtering", () => {
  it("does not count VALIDATION errors as failures", async () => {
    const cb = new CircuitBreaker("r1", { failureThreshold: 2, cooldownMs: 30000 });
    const validationErr = new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "BAD",
      message: "bad input",
      recoverability: { retryable: false, suggestedAction: "fix it" },
    });
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(() => Promise.reject(validationErr))).rejects.toThrow();
    }
    expect(cb.state).toBe("closed");
  });

  it("trips on ROUTER_UNREACHABLE errors", async () => {
    const cb = new CircuitBreaker("r1", { failureThreshold: 2, cooldownMs: 30000 });
    const unreachable = new MikroMCPError({
      category: ErrorCategory.ROUTER_UNREACHABLE,
      code: "ECONNREFUSED",
      message: "unreachable",
      recoverability: { retryable: true, suggestedAction: "retry" },
    });
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(() => Promise.reject(unreachable))).rejects.toThrow();
    }
    expect(cb.state).toBe("open");
  });

  it("does not count plain Error as a transient failure", async () => {
    const cb = new CircuitBreaker("r1", { failureThreshold: 2, cooldownMs: 30000 });
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(() => Promise.reject(new Error("plain")))).rejects.toThrow("plain");
    }
    expect(cb.state).toBe("closed");
  });
});

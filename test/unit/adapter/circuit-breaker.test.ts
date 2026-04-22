import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker } from "../../../src/adapter/circuit-breaker.js";

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
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow("fail");
    }
    expect(cb.state).toBe("open");
  });

  it("rejects immediately when open", async () => {
    // Force open
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow();
    }

    await expect(cb.execute(() => Promise.resolve("ok"))).rejects.toThrow("Circuit breaker is open");
  });

  it("transitions to half-open after cooldown", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow();
    }
    expect(cb.state).toBe("open");

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");
  });

  it("closes on success in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");

    const result = await cb.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
  });

  it("reopens on failure in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.state).toBe("half-open");

    await expect(cb.execute(() => Promise.reject(new Error("still broken")))).rejects.toThrow();
    expect(cb.state).toBe("open");
  });

  it("resets to closed", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(error))).rejects.toThrow();
    }
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
  });
});

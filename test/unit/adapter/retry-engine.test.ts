import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../../src/adapter/retry-engine.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and succeeds", async () => {
    const error = new Error("connection failed");
    (error as NodeJS.ErrnoException).code = "ECONNREFUSED";

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors (4xx)", async () => {
    const error = Object.assign(new Error("not found"), { statusCode: 404 });

    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 }),
    ).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const error = new Error("timeout");
    (error as NodeJS.ErrnoException).code = "ETIMEDOUT";

    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 }),
    ).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

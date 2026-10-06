import { describe, it, expect } from "vitest";
import { z } from "zod";
import { enrichError } from "../../../src/domain/errors/error-enricher.js";
import { errors as undiciErrors } from "undici";
import { HttpError } from "../../../src/adapter/rest-client.js";
import { ErrorCategory, MikroMCPError } from "../../../src/domain/errors/error-types.js";

describe("enrichError", () => {
  it("maps ZodError to VALIDATION category", () => {
    let zodErr: unknown;
    try {
      z.object({ x: z.number() }).strict().parse({ x: "bad" });
    } catch (e) {
      zodErr = e;
    }
    const result = enrichError(zodErr, { tool: "test_tool" });
    expect(result.category).toBe(ErrorCategory.VALIDATION);
    expect(result.code).toBe("VALIDATION_ERROR");
  });

  it("preserves MikroMCPError unchanged", () => {
    const err = new MikroMCPError({
      category: ErrorCategory.NOT_FOUND,
      code: "X",
      message: "msg",
      recoverability: { retryable: false, suggestedAction: "n/a" },
    });
    expect(enrichError(err)).toBe(err);
  });

  it("maps a REST session closed after 60 s to a non-retryable ROUTER_TIMEOUT", () => {
    const err = new HttpError(
      400,
      JSON.stringify({ detail: "Session closed", error: 400, message: "Bad Request" }),
    );
    const result = enrichError(err, { tool: "traceroute" });
    expect(result.category).toBe(ErrorCategory.ROUTER_TIMEOUT);
    expect(result.code).toBe("REST_SESSION_CLOSED");
    expect(result.recoverability.retryable).toBe(false);
  });

  it("keeps other HTTP 400 responses as VALIDATION", () => {
    const err = new HttpError(
      400,
      JSON.stringify({ detail: "input does not match any value of interface", error: 400 }),
    );
    expect(enrichError(err).category).toBe(ErrorCategory.VALIDATION);
  });

  it("still reclassifies a RouterOS 500 permission error", () => {
    const err = new HttpError(500, JSON.stringify({ detail: "not enough permissions (9)" }));
    expect(enrichError(err).category).toBe(ErrorCategory.PERMISSION_DENIED);
  });

  it.each([
    ["headers", new undiciErrors.HeadersTimeoutError()],
    ["body", new undiciErrors.BodyTimeoutError()],
  ])("maps undici's %s timeout to a retryable ROUTER_TIMEOUT", (_label, err) => {
    const result = enrichError(err, { tool: "torch" });
    expect(result.category).toBe(ErrorCategory.ROUTER_TIMEOUT);
    expect(result.code).toBe((err as { code: string }).code);
    expect(result.recoverability.retryable).toBe(true);
  });
});

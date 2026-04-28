import { describe, it, expect } from "vitest";
import { z } from "zod";
import { enrichError } from "../../../src/domain/errors/error-enricher.js";
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
});

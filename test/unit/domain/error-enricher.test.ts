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

  it("maps an ssh2 client-authentication error to ROUTER_AUTH_FAILED", () => {
    // Shape emitted by ssh2 when the router refuses every configured auth method.
    const sshErr = Object.assign(new Error("All configured authentication methods failed"), {
      level: "client-authentication",
    });
    const result = enrichError(sshErr, { routerId: "r1", tool: "export_config" });
    expect(result.category).toBe(ErrorCategory.ROUTER_AUTH_FAILED);
    expect(result.code).toBe("SSH_AUTH_FAILED");
    expect(result.message).toContain("All configured authentication methods failed");
    expect(result.details).toMatchObject({
      transport: "ssh",
      routerId: "r1",
      tool: "export_config",
    });
    expect(result.recoverability.retryable).toBe(false);
    expect(result.recoverability.suggestedAction).toContain("ssh policy");
  });

  it("keeps an error without a known code or level as INTERNAL", () => {
    const result = enrichError(new Error("boom"));
    expect(result.category).toBe(ErrorCategory.INTERNAL);
    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

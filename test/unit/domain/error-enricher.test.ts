import { describe, it, expect } from "vitest";
import { z } from "zod";
import { enrichError } from "../../../src/domain/errors/error-enricher.js";
import { errors as undiciErrors } from "undici";
import { HttpError } from "../../../src/adapter/rest-client.js";
import { pinHostKey } from "../../../src/adapter/ssh-host-key.js";
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

  it("maps an ssh2 client-timeout error to ROUTER_UNREACHABLE without retry", () => {
    // Shape emitted by ssh2 when the handshake does not finish within readyTimeout.
    const sshErr = Object.assign(new Error("Timed out while waiting for handshake"), {
      level: "client-timeout",
    });
    const result = enrichError(sshErr, { routerId: "r1", tool: "ping" });
    expect(result.category).toBe(ErrorCategory.ROUTER_UNREACHABLE);
    expect(result.code).toBe("SSH_HANDSHAKE_TIMEOUT");
    expect(result.message).toContain("Timed out while waiting for handshake");
    expect(result.details).toMatchObject({ transport: "ssh", routerId: "r1", tool: "ping" });
    expect(result.recoverability.retryable).toBe(false);
    expect(result.recoverability.suggestedAction).toContain("/ip service ssh");
  });

  it("maps a refused SSH host key to ROUTER_AUTH_FAILED with both fingerprints", () => {
    const pin = pinHostKey("ab".repeat(32));
    pin.hostVerifier(Buffer.from("router-host-key"));
    const refused = pin.connectionError(
      Object.assign(new Error("Host denied (verification failed)"), { level: "handshake" }),
    );

    const result = enrichError(refused, { routerId: "r1", tool: "run_command" });

    expect(result.category).toBe(ErrorCategory.ROUTER_AUTH_FAILED);
    expect(result.code).toBe("SSH_HOST_KEY_MISMATCH");
    expect(result.message).toContain(`Expected: ${"ab".repeat(32)}, got: `);
    expect(result.details).toMatchObject({
      transport: "ssh",
      expected: "ab".repeat(32),
      actual: (refused as Error & { actual: string }).actual,
      routerId: "r1",
      tool: "run_command",
    });
    expect(result.recoverability.retryable).toBe(false);
    expect(result.recoverability.suggestedAction).toContain("unverified");
  });

  it("keeps an ssh2 handshake error without a refused host key INTERNAL", () => {
    // ssh2 uses level "handshake" for algorithm negotiation failures as well.
    const sshErr = Object.assign(
      new Error("Handshake failed: no matching key exchange algorithm"),
      {
        level: "handshake",
      },
    );
    expect(enrichError(sshErr).category).toBe(ErrorCategory.INTERNAL);
  });

  it("keeps an ssh2 client-socket error classified by its errno code", () => {
    // ssh2 adds level "client-socket" to socket errors but keeps their errno code.
    const sshErr = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:22"), {
      level: "client-socket",
      code: "ECONNREFUSED",
    });
    const result = enrichError(sshErr);
    expect(result.category).toBe(ErrorCategory.ROUTER_UNREACHABLE);
    expect(result.code).toBe("ECONNREFUSED");
  });

  it("keeps an error without a known code or level as INTERNAL", () => {
    const result = enrichError(new Error("boom"));
    expect(result.category).toBe(ErrorCategory.INTERNAL);
    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Identity } from "../../../src/types.js";

const SECRET = "test-confirmation-secret-32chars!!";

function makeIdentity(role: Identity["role"]): Identity {
  return { id: "test-user", role, allowedRouters: [], allowedToolPatterns: [] };
}

function isMikroMCPError(err: unknown): err is { category: string; code: string; details?: Record<string, unknown> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "category" in err &&
    "code" in err &&
    (err as Record<string, unknown>).name === "MikroMCPError"
  );
}

describe("confirmation middleware", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("admin identity bypasses confirmation gate", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("admin");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET)).resolves.toBeUndefined();
  });

  it("superadmin identity bypasses confirmation gate", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("superadmin");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET)).resolves.toBeUndefined();
  });

  it("operator first call throws APPROVAL_REQUIRED with confirmationToken in details", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET)
    ).rejects.toSatisfy((err: unknown) => {
      if (!isMikroMCPError(err)) return false;
      return (
        err.category === "APPROVAL_REQUIRED" &&
        err.code === "CONFIRMATION_REQUIRED" &&
        typeof (err.details as Record<string, unknown>).confirmationToken === "string"
      );
    });
  });

  it("operator second call with valid token succeeds (resolves undefined)", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    let token = "";
    try {
      await checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET);
    } catch (err) {
      token = ((err as { details: Record<string, unknown> }).details).confirmationToken as string;
    }
    expect(token).toBeTruthy();
    const paramsWithToken = { ...params, confirmationToken: token };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", paramsWithToken, identity, SECRET)
    ).resolves.toBeUndefined();
  });

  it("token is single-use — second use of same token throws APPROVAL_REQUIRED", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    let token = "";
    try {
      await checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET);
    } catch (err) {
      token = ((err as { details: Record<string, unknown> }).details).confirmationToken as string;
    }
    await checkConfirmation("manage_firewall_rule", "edge-01", { ...params, confirmationToken: token }, identity, SECRET);
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", { ...params, confirmationToken: token }, identity, SECRET)
    ).rejects.toSatisfy((err: unknown) => isMikroMCPError(err));
  });

  it("throws when confirmationToken does not match params (param hash mismatch)", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    let token = "";
    try {
      await checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET);
    } catch (err) {
      token = ((err as { details: Record<string, unknown> }).details).confirmationToken as string;
    }
    const tampered = { routerId: "edge-01", action: "add", confirmationToken: token };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", tampered, identity, SECRET)
    ).rejects.toSatisfy((err: unknown) =>
      isMikroMCPError(err) && err.category === "PERMISSION_DENIED"
    );
  });

  it("readonly identity also requires confirmation", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("readonly");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET)
    ).rejects.toSatisfy((err: unknown) =>
      isMikroMCPError(err) && err.category === "APPROVAL_REQUIRED"
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Identity } from "../../../src/types.js";

const SECRET = "test-confirmation-secret-32chars!!";

function makeIdentity(role: Identity["role"]): Identity {
  return { id: "test-user", role, allowedRouters: [], allowedToolPatterns: [] };
}

function isMikroMCPError(
  err: unknown,
): err is { category: string; code: string; details?: Record<string, unknown> } {
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
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET),
    ).resolves.toBeUndefined();
  });

  it("superadmin identity bypasses confirmation gate", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("superadmin");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET),
    ).resolves.toBeUndefined();
  });

  it("operator first call throws APPROVAL_REQUIRED with confirmationToken in details", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET),
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
      token = (err as { details: Record<string, unknown> }).details.confirmationToken as string;
    }
    expect(token).toBeTruthy();
    const paramsWithToken = { ...params, confirmationToken: token };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", paramsWithToken, identity, SECRET),
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
      token = (err as { details: Record<string, unknown> }).details.confirmationToken as string;
    }
    await checkConfirmation(
      "manage_firewall_rule",
      "edge-01",
      { ...params, confirmationToken: token },
      identity,
      SECRET,
    );
    await expect(
      checkConfirmation(
        "manage_firewall_rule",
        "edge-01",
        { ...params, confirmationToken: token },
        identity,
        SECRET,
      ),
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
      token = (err as { details: Record<string, unknown> }).details.confirmationToken as string;
    }
    const tampered = { routerId: "edge-01", action: "add", confirmationToken: token };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", tampered, identity, SECRET),
    ).rejects.toSatisfy(
      (err: unknown) => isMikroMCPError(err) && err.category === "PERMISSION_DENIED",
    );
  });

  it("token stays valid across a module reload (self-verifying, survives restart)", async () => {
    const mod1 = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("operator");
    const params = { routerId: "edge-01", action: "remove" };
    let token = "";
    try {
      await mod1.checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET);
    } catch (err) {
      token = (err as { details: Record<string, unknown> }).details.confirmationToken as string;
    }
    // Simulate a process restart: fresh module instance, empty replay cache.
    vi.resetModules();
    const mod2 = await import("../../../src/middleware/confirmation.js");
    await expect(
      mod2.checkConfirmation(
        "manage_firewall_rule",
        "edge-01",
        { ...params, confirmationToken: token },
        identity,
        SECRET,
      ),
    ).resolves.toBeUndefined();
  });

  it("readonly identity also requires confirmation", async () => {
    const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
    const identity = makeIdentity("readonly");
    const params = { routerId: "edge-01", action: "remove" };
    await expect(
      checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET),
    ).rejects.toSatisfy(
      (err: unknown) => isMikroMCPError(err) && err.category === "APPROVAL_REQUIRED",
    );
  });

  describe("state binding", () => {
    async function issue(
      params: Record<string, unknown>,
      identity: Identity,
      state: () => Promise<string>,
    ): Promise<{ token: string; details: Record<string, unknown> }> {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      try {
        await checkConfirmation("manage_firewall_rule", "edge-01", params, identity, SECRET, state);
      } catch (err) {
        const details = (err as { details: Record<string, unknown> }).details;
        return { token: details.confirmationToken as string, details };
      }
      throw new Error("expected APPROVAL_REQUIRED");
    }

    it("reports the fingerprint the token was issued against", async () => {
      const { details } = await issue(
        { routerId: "edge-01", action: "remove" },
        makeIdentity("operator"),
        async () => "a".repeat(64),
      );
      expect(details.stateFingerprint).toBe("a".repeat(64));
      expect(details.confirmationToken).toContain(`.${"a".repeat(64)}.`);
    });

    it("refuses the token with CONFIRMATION_STATE_CHANGED when the state moved after the preview", async () => {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      const identity = makeIdentity("operator");
      const params = { routerId: "edge-01", action: "remove", comment: "block-lab" };
      let state = "before";
      const read = async () => state;
      const { token } = await issue(params, identity, read);

      state = "after";
      await expect(
        checkConfirmation(
          "manage_firewall_rule",
          "edge-01",
          { ...params, confirmationToken: token },
          identity,
          SECRET,
          read,
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isMikroMCPError(err) &&
          err.code === "CONFIRMATION_STATE_CHANGED" &&
          err.category === "CONFLICT",
      );
    });

    it("does not consume a token refused for drift, so it holds again if the state returns", async () => {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      const identity = makeIdentity("operator");
      const params = { routerId: "edge-01", action: "remove" };
      let state = "before";
      const read = async () => state;
      const { token } = await issue(params, identity, read);
      const confirmed = { ...params, confirmationToken: token };

      state = "after";
      await expect(
        checkConfirmation("manage_firewall_rule", "edge-01", confirmed, identity, SECRET, read),
      ).rejects.toBeDefined();
      state = "before";
      await expect(
        checkConfirmation("manage_firewall_rule", "edge-01", confirmed, identity, SECRET, read),
      ).resolves.toBeUndefined();
    });

    it("refuses a token whose embedded fingerprint was edited (MAC covers it)", async () => {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      const identity = makeIdentity("operator");
      const params = { routerId: "edge-01", action: "remove" };
      const { token } = await issue(params, identity, async () => "before");
      const [exp, nonce, , mac] = token.split(".");
      const forged = `${exp}.${nonce}.after.${mac}`;
      await expect(
        checkConfirmation(
          "manage_firewall_rule",
          "edge-01",
          { ...params, confirmationToken: forged },
          identity,
          SECRET,
          async () => "after",
        ),
      ).rejects.toSatisfy(
        (err: unknown) => isMikroMCPError(err) && err.code === "CONFIRMATION_MISMATCH",
      );
    });

    it("does not read router state for a token that fails the MAC check", async () => {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      const read = vi.fn().mockResolvedValue("x");
      await expect(
        checkConfirmation(
          "manage_firewall_rule",
          "edge-01",
          { routerId: "edge-01", confirmationToken: `${Date.now() + 60_000}.n.x.deadbeef` },
          makeIdentity("operator"),
          SECRET,
          read,
        ),
      ).rejects.toBeDefined();
      expect(read).not.toHaveBeenCalled();
    });

    it("admins bypass the token, so no state is read", async () => {
      const { checkConfirmation } = await import("../../../src/middleware/confirmation.js");
      const read = vi.fn().mockResolvedValue("x");
      await checkConfirmation(
        "manage_firewall_rule",
        "edge-01",
        { routerId: "edge-01" },
        makeIdentity("admin"),
        SECRET,
        read,
      );
      expect(read).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect } from "vitest";
import { checkFleetConfirmation } from "../../../src/middleware/fleet-confirmation.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const secret = "test-secret";
const base = {
  toolName: "manage_route",
  routerIds: ["r1", "r2"],
  params: { action: "remove" },
  identityId: "op1",
};

describe("checkFleetConfirmation", () => {
  it("issues an APPROVAL_REQUIRED error with a token on the first call", () => {
    try {
      checkFleetConfirmation({ ...base, submittedToken: undefined }, secret);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MikroMCPError);
      expect((err as MikroMCPError).category).toBe(ErrorCategory.APPROVAL_REQUIRED);
      expect((err as MikroMCPError).details?.confirmationToken).toBeTypeOf("string");
    }
  });

  it("accepts the issued token on the second identical call", () => {
    let token = "";
    try {
      checkFleetConfirmation({ ...base, submittedToken: undefined }, secret);
    } catch (err) {
      token = (err as MikroMCPError).details!.confirmationToken as string;
    }
    expect(() => checkFleetConfirmation({ ...base, submittedToken: token }, secret)).not.toThrow();
  });

  it("rejects a token when the router set differs", () => {
    let token = "";
    try {
      checkFleetConfirmation({ ...base, submittedToken: undefined }, secret);
    } catch (err) {
      token = (err as MikroMCPError).details!.confirmationToken as string;
    }
    expect(() =>
      checkFleetConfirmation({ ...base, routerIds: ["r1"], submittedToken: token }, secret),
    ).toThrow();
  });
});

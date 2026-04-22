import { describe, it, expect } from "vitest";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

describe("MikroMCPError", () => {
  it("creates error with all fields", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "INVALID_VLAN_ID",
      message: "VLAN ID must be between 1 and 4094",
      details: { vlanId: 5000 },
      recoverability: {
        retryable: false,
        suggestedAction: "Provide a VLAN ID between 1 and 4094.",
      },
    });

    expect(error.name).toBe("MikroMCPError");
    expect(error.message).toBe("VLAN ID must be between 1 and 4094");
    expect(error.category).toBe(ErrorCategory.VALIDATION);
    expect(error.code).toBe("INVALID_VLAN_ID");
    expect(error.details).toEqual({ vlanId: 5000 });
    expect(error.recoverability.retryable).toBe(false);
  });

  it("serializes to JSON", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.ROUTER_UNREACHABLE,
      code: "CONNECTION_FAILED",
      message: "Cannot reach router",
      recoverability: {
        retryable: true,
        retryAfterMs: 5000,
        suggestedAction: "Check network connectivity.",
      },
    });

    const json = error.toJSON();
    expect(json.category).toBe("ROUTER_UNREACHABLE");
    expect(json.code).toBe("CONNECTION_FAILED");
    expect(json.message).toBe("Cannot reach router");
    expect(json.recoverability).toBeDefined();
  });

  it("converts to MikroMCPErrorData", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.CONFLICT,
      code: "VLAN_NAME_CONFLICT",
      message: "VLAN name already used",
      recoverability: {
        retryable: false,
        suggestedAction: "Use a different name.",
        alternativeTools: ["list_interfaces"],
      },
    });

    const data = error.toMikroMCPErrorData();
    expect(data.category).toBe("CONFLICT");
    expect(data.recoverability.alternativeTools).toEqual(["list_interfaces"]);
  });

  it("is instanceof Error", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.INTERNAL,
      code: "UNEXPECTED",
      message: "Something went wrong",
      recoverability: { retryable: true, suggestedAction: "Retry." },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MikroMCPError);
  });
});

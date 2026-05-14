import { describe, it, expect, vi } from "vitest";
import type { Identity } from "../../../src/types.js";
import type { IncomingMessage } from "node:http";

const mockIdentity: Identity = {
  id: "ci-pipeline",
  role: "operator",
  allowedRouters: ["edge-01"],
  allowedToolPatterns: ["list_*"],
};

const mockRegistry = {
  findIdentityByToken: vi.fn(),
  getIdentities: vi.fn().mockReturnValue([]),
};

function makeReq(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as IncomingMessage;
}

describe("extractBearerToken", () => {
  it("extracts token from valid Authorization header", async () => {
    const { extractBearerToken } = await import("../../../src/middleware/auth.js");
    expect(extractBearerToken("Bearer mytoken123")).toBe("mytoken123");
  });

  it("returns null for missing header", async () => {
    const { extractBearerToken } = await import("../../../src/middleware/auth.js");
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for non-Bearer scheme", async () => {
    const { extractBearerToken } = await import("../../../src/middleware/auth.js");
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });
});

describe("authenticateHttp", () => {
  it("throws PERMISSION_DENIED when Authorization header is missing", async () => {
    const { authenticateHttp } = await import("../../../src/middleware/auth.js");
    const { MikroMCPError, ErrorCategory } = await import("../../../src/domain/errors/error-types.js");
    mockRegistry.findIdentityByToken.mockResolvedValue(null);
    const req = makeReq();
    await expect(
      authenticateHttp(req, mockRegistry as never)
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof MikroMCPError && err.category === ErrorCategory.PERMISSION_DENIED
    );
  });

  it("throws PERMISSION_DENIED with code INVALID_TOKEN when token does not match", async () => {
    const { authenticateHttp } = await import("../../../src/middleware/auth.js");
    const { MikroMCPError } = await import("../../../src/domain/errors/error-types.js");
    mockRegistry.findIdentityByToken.mockResolvedValue(null);
    const req = makeReq("Bearer bad-token");
    await expect(
      authenticateHttp(req, mockRegistry as never)
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof MikroMCPError && (err as MikroMCPError).code === "INVALID_TOKEN"
    );
  });

  it("returns the Identity when token matches", async () => {
    const { authenticateHttp } = await import("../../../src/middleware/auth.js");
    mockRegistry.findIdentityByToken.mockResolvedValue(mockIdentity);
    const req = makeReq("Bearer valid-token");
    const result = await authenticateHttp(req, mockRegistry as never);
    expect(result.id).toBe("ci-pipeline");
    expect(result.role).toBe("operator");
  });
});

describe("getStdioIdentity", () => {
  it("returns built-in superadmin when stdioIdentity is undefined", async () => {
    const { getStdioIdentity } = await import("../../../src/middleware/auth.js");
    const identity = getStdioIdentity(undefined, mockRegistry as never);
    expect(identity.role).toBe("superadmin");
    expect(identity.allowedRouters).toEqual([]);
    expect(identity.allowedToolPatterns).toEqual([]);
  });

  it("returns named identity from registry when stdioIdentity is set", async () => {
    const { getStdioIdentity } = await import("../../../src/middleware/auth.js");
    mockRegistry.getIdentities.mockReturnValue([mockIdentity]);
    const identity = getStdioIdentity("ci-pipeline", mockRegistry as never);
    expect(identity.id).toBe("ci-pipeline");
    expect(identity.role).toBe("operator");
  });

  it("throws CONFIGURATION when named stdio identity is not found in registry", async () => {
    const { getStdioIdentity } = await import("../../../src/middleware/auth.js");
    const { MikroMCPError } = await import("../../../src/domain/errors/error-types.js");
    mockRegistry.getIdentities.mockReturnValue([]);
    expect(() => getStdioIdentity("nonexistent", mockRegistry as never)).toThrow(MikroMCPError);
  });
});

describe("withIdentity / getCurrentIdentity", () => {
  it("getCurrentIdentity returns the identity set by withIdentity", async () => {
    const { withIdentity, getCurrentIdentity } = await import("../../../src/middleware/auth.js");
    await withIdentity(mockIdentity, async () => {
      expect(getCurrentIdentity()).toEqual(mockIdentity);
    });
  });

  it("getCurrentIdentity returns undefined outside withIdentity", async () => {
    const { getCurrentIdentity } = await import("../../../src/middleware/auth.js");
    expect(getCurrentIdentity()).toBeUndefined();
  });
});

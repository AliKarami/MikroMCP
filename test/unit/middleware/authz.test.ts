import { describe, it, expect } from "vitest";
import { checkAuthz } from "../../../src/middleware/authz.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";
import type { Identity } from "../../../src/types.js";

function makeIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: "ci-pipeline",
    role: "operator",
    allowedRouters: [],
    allowedToolPatterns: [],
    ...overrides,
  };
}

describe("checkAuthz — router check", () => {
  it("passes when allowedRouters is empty (all routers allowed)", () => {
    const identity = makeIdentity({ allowedRouters: [] });
    expect(() => checkAuthz(identity, "any-tool", "any-router")).not.toThrow();
  });

  it("passes when routerId is in allowedRouters", () => {
    const identity = makeIdentity({ allowedRouters: ["edge-01", "edge-02"] });
    expect(() => checkAuthz(identity, "list_routes", "edge-01")).not.toThrow();
  });

  it("throws PERMISSION_DENIED with ROUTER_NOT_ALLOWED when router not in list", () => {
    const identity = makeIdentity({ allowedRouters: ["edge-01"] });
    let thrown: unknown;
    try {
      checkAuthz(identity, "list_routes", "core-01");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toSatisfy((err: unknown) =>
      err instanceof MikroMCPError &&
      err.category === ErrorCategory.PERMISSION_DENIED &&
      (err as MikroMCPError).code === "ROUTER_NOT_ALLOWED"
    );
  });
});

describe("checkAuthz — tool pattern check", () => {
  it("passes when allowedToolPatterns is empty (all tools allowed)", () => {
    const identity = makeIdentity({ allowedToolPatterns: [] });
    expect(() => checkAuthz(identity, "manage_firewall_rule", "edge-01")).not.toThrow();
  });

  it("passes when tool name matches exact pattern", () => {
    const identity = makeIdentity({ allowedToolPatterns: ["ping", "traceroute"] });
    expect(() => checkAuthz(identity, "ping", "edge-01")).not.toThrow();
  });

  it("passes when tool name matches wildcard pattern", () => {
    const identity = makeIdentity({ allowedToolPatterns: ["list_*"] });
    expect(() => checkAuthz(identity, "list_routes", "edge-01")).not.toThrow();
  });

  it("passes with trailing wildcard matching any suffix", () => {
    const identity = makeIdentity({ allowedToolPatterns: ["manage_*"] });
    expect(() => checkAuthz(identity, "manage_firewall_rule", "edge-01")).not.toThrow();
  });

  it("honors a wildcard in the middle of the pattern", () => {
    const identity = makeIdentity({ allowedToolPatterns: ["manage_*_rule"] });
    expect(() => checkAuthz(identity, "manage_firewall_rule", "edge-01")).not.toThrow();
    expect(() => checkAuthz(identity, "manage_user", "edge-01")).toThrow(MikroMCPError);
  });

  it("does not treat a leading-wildcard suffix pattern as allow-all", () => {
    // Old prefix-only matcher took the text before the first '*' — here the
    // empty prefix — and allowed everything. A real glob must anchor the tail.
    const identity = makeIdentity({ allowedToolPatterns: ["*_wifi"] });
    expect(() => checkAuthz(identity, "manage_wifi", "edge-01")).not.toThrow();
    expect(() => checkAuthz(identity, "manage_user", "edge-01")).toThrow(MikroMCPError);
  });

  it("throws PERMISSION_DENIED with TOOL_NOT_ALLOWED when no pattern matches", () => {
    const identity = makeIdentity({ allowedToolPatterns: ["list_*", "ping"] });
    let thrown: unknown;
    try {
      checkAuthz(identity, "manage_firewall_rule", "edge-01");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toSatisfy((err: unknown) =>
      err instanceof MikroMCPError &&
      err.category === ErrorCategory.PERMISSION_DENIED &&
      (err as MikroMCPError).code === "TOOL_NOT_ALLOWED"
    );
  });
});

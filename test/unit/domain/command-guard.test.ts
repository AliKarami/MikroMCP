import { describe, it, expect } from "vitest";
import {
  BUILTIN_DENY_PATTERNS,
  resolveCommandPolicy,
  checkCommand,
} from "../../../src/domain/tools/command-guard.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import type { RouterConfig } from "../../../src/types.js";

function makeRouterConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
    ...overrides,
  };
}

describe("BUILTIN_DENY_PATTERNS", () => {
  it("includes /system shutdown*", () => {
    expect(BUILTIN_DENY_PATTERNS.some((p) => p.startsWith("/system shutdown"))).toBe(true);
  });

  it("includes /system reboot*", () => {
    expect(BUILTIN_DENY_PATTERNS.some((p) => p.startsWith("/system reboot"))).toBe(true);
  });

  it("has at least 10 entries", () => {
    expect(BUILTIN_DENY_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("resolveCommandPolicy", () => {
  it("deny list includes built-in patterns when no overrides", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(policy.deny).toEqual(expect.arrayContaining(BUILTIN_DENY_PATTERNS));
  });

  it("deny list merges built-in + global + per-router additively", () => {
    const policy = resolveCommandPolicy(
      makeRouterConfig({ cmdDeny: ["/custom/router*"] }),
      [],
      ["/custom/global*"],
    );
    expect(policy.deny).toContain("/custom/global*");
    expect(policy.deny).toContain("/custom/router*");
    expect(policy.deny).toEqual(expect.arrayContaining(BUILTIN_DENY_PATTERNS));
  });

  it("per-router allow list takes precedence over global allow list", () => {
    const policy = resolveCommandPolicy(
      makeRouterConfig({ cmdAllow: ["/ip/route/*"] }),
      ["/system/identity*"],
      [],
    );
    expect(policy.allow).toEqual(["/ip/route/*"]);
  });

  it("global allow list used when no per-router allow list", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), ["/system/identity*"], []);
    expect(policy.allow).toEqual(["/system/identity*"]);
  });

  it("allow list is empty when neither per-router nor global is set", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(policy.allow).toEqual([]);
  });
});

describe("checkCommand", () => {
  it("does not throw for an allowed command when no allow list is set", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(() => checkCommand("/ip/route/print", policy)).not.toThrow();
  });

  it("throws MikroMCPError for /system shutdown", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(() => checkCommand("/system shutdown", policy)).toThrow(MikroMCPError);
  });

  it("throws for /system reboot and suggests reboot tool", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    try {
      checkCommand("/system reboot", policy);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MikroMCPError);
      const e = err as MikroMCPError;
      expect(e.recoverability.alternativeTools).toContain("reboot");
    }
  });

  it("throws for /user set password change", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(() => checkCommand("/user set password=newpass", policy)).toThrow(MikroMCPError);
  });

  it("throws for /system reset-configuration", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(() => checkCommand("/system reset-configuration", policy)).toThrow(MikroMCPError);
  });

  it("is case-insensitive for deny patterns", () => {
    const policy = resolveCommandPolicy(makeRouterConfig(), [], []);
    expect(() => checkCommand("/SYSTEM SHUTDOWN", policy)).toThrow(MikroMCPError);
  });

  it("throws when command does not match allow list", () => {
    const policy = resolveCommandPolicy(makeRouterConfig({ cmdAllow: ["/ip/route/*"] }), [], []);
    expect(() => checkCommand("/system/identity/print", policy)).toThrow(MikroMCPError);
  });

  it("does not throw when command matches allow list", () => {
    const policy = resolveCommandPolicy(makeRouterConfig({ cmdAllow: ["/ip/route/*"] }), [], []);
    expect(() => checkCommand("/ip/route/print", policy)).not.toThrow();
  });

  it("throws per-router deny even if command would pass allow list", () => {
    const policy = resolveCommandPolicy(
      makeRouterConfig({ cmdAllow: ["/ip/*"], cmdDeny: ["/ip/service/set*"] }),
      [],
      [],
    );
    expect(() => checkCommand("/ip/service/set disabled=yes", policy)).toThrow(MikroMCPError);
  });
});

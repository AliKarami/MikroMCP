import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  createRequestGuard,
  isLoopbackBind,
  parseIpAllowlist,
  type RequestGuardConfig,
} from "../../../src/middleware/request-guard.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";

function req(headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function guard(overrides: Partial<RequestGuardConfig> = {}) {
  return createRequestGuard({
    bindHost: "127.0.0.1",
    allowedHosts: [],
    allowedOrigins: [],
    allowedIps: [],
    ...overrides,
  });
}

describe("isLoopbackBind", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"])("treats %s as loopback", (h) => {
    expect(isLoopbackBind(h)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.0.2.10", "mcp.example.com"])("treats %s as reachable", (h) => {
    expect(isLoopbackBind(h)).toBe(false);
  });
});

describe("loopback bind, no lists (the default)", () => {
  const g = guard();

  it("has an active host check", () => {
    expect(g.hostCheckActive).toBe(true);
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"])(
    "accepts Host %s",
    (host) => {
      expect(g.check(req({ host })).ok).toBe(true);
    },
  );

  it("refuses a rebinding Host name", () => {
    const verdict = g.check(req({ host: "attacker.example:3000" }));
    expect(verdict).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
  });

  it("refuses a request with no Host header", () => {
    expect(g.check(req({}))).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
  });

  it("accepts a request without an Origin header (non-browser client)", () => {
    expect(g.check(req({ host: "localhost:3000" })).ok).toBe(true);
  });

  it("accepts a localhost browser Origin", () => {
    expect(g.check(req({ host: "localhost:3000", origin: "http://localhost:5173" })).ok).toBe(true);
  });

  it("refuses a foreign browser Origin", () => {
    const verdict = g.check(req({ host: "localhost:3000", origin: "https://evil.example" }));
    expect(verdict).toMatchObject({ ok: false, code: "ORIGIN_NOT_ALLOWED" });
  });

  it("refuses the opaque null Origin", () => {
    const verdict = g.check(req({ host: "localhost:3000", origin: "null" }));
    expect(verdict).toMatchObject({ ok: false, code: "ORIGIN_NOT_ALLOWED" });
  });
});

describe("non-loopback bind", () => {
  it("turns the host check off when no host list is set", () => {
    const g = guard({ bindHost: "0.0.0.0" });
    expect(g.hostCheckActive).toBe(false);
    expect(g.check(req({ host: "anything.example", origin: "https://anything.example" })).ok).toBe(
      true,
    );
  });

  it("enforces an explicit host list, with or without a port", () => {
    const g = guard({ bindHost: "0.0.0.0", allowedHosts: ["mcp.example.com", "10.0.0.5:3000"] });
    expect(g.hostCheckActive).toBe(true);
    expect(g.check(req({ host: "mcp.example.com" })).ok).toBe(true);
    expect(g.check(req({ host: "mcp.example.com:8443" })).ok).toBe(true);
    expect(g.check(req({ host: "10.0.0.5:3000" })).ok).toBe(true);
    expect(g.check(req({ host: "10.0.0.5:4000" })).ok).toBe(false);
    expect(g.check(req({ host: "other.example.com" })).ok).toBe(false);
  });

  it("derives the allowed origins from the host list", () => {
    const g = guard({ bindHost: "0.0.0.0", allowedHosts: ["mcp.example.com"] });
    expect(g.check(req({ host: "mcp.example.com", origin: "https://mcp.example.com" })).ok).toBe(
      true,
    );
    expect(g.check(req({ host: "mcp.example.com", origin: "https://evil.example" })).ok).toBe(
      false,
    );
  });

  it("uses an explicit origin list instead of the host list when one is set", () => {
    const g = guard({
      bindHost: "0.0.0.0",
      allowedHosts: ["mcp.example.com"],
      allowedOrigins: ["https://app.example.com/"],
    });
    expect(g.check(req({ host: "mcp.example.com", origin: "https://app.example.com" })).ok).toBe(
      true,
    );
    expect(g.check(req({ host: "mcp.example.com", origin: "https://mcp.example.com" })).ok).toBe(
      false,
    );
  });

  it("* turns the host check off and * allows any origin", () => {
    const g = guard({ bindHost: "127.0.0.1", allowedHosts: ["*"], allowedOrigins: ["*"] });
    expect(g.hostCheckActive).toBe(false);
    expect(g.check(req({ host: "x.example", origin: "https://y.example" })).ok).toBe(true);
  });
});

describe("client IP allow list", () => {
  const g = guard({ allowedIps: ["10.0.0.0/8", "192.0.2.7", "2001:db8::/32"] });

  it.each(["10.1.2.3", "192.0.2.7", "::ffff:10.9.9.9", "2001:db8::1"])("admits %s", (ip) => {
    expect(g.check(req({ host: "localhost" }, ip)).ok).toBe(true);
  });

  it.each(["192.0.2.8", "127.0.0.1", "::1", "2001:db9::1"])("refuses %s", (ip) => {
    expect(g.check(req({ host: "localhost" }, ip))).toMatchObject({
      ok: false,
      code: "CLIENT_IP_NOT_ALLOWED",
    });
  });

  it("refuses a request whose socket address is unknown", () => {
    const unknown = { headers: { host: "localhost" }, socket: {} } as unknown as IncomingMessage;
    expect(g.check(unknown).ok).toBe(false);
  });
});

describe("parseIpAllowlist", () => {
  it("returns undefined for an empty list (no IP check)", () => {
    expect(parseIpAllowlist([])).toBeUndefined();
  });

  it.each(["not-an-ip", "10.0.0.0/33", "10.0.0.0/x", "2001:db8::/129", "10.0.0.1/8/1"])(
    "throws a CONFIGURATION error for %s",
    (entry) => {
      expect(() => parseIpAllowlist([entry])).toThrow(MikroMCPError);
      try {
        parseIpAllowlist([entry]);
      } catch (err) {
        expect((err as MikroMCPError).code).toBe("INVALID_HTTP_ALLOWLIST");
        expect((err as MikroMCPError).message).toContain("MIKROMCP_HTTP_ALLOWED_IPS");
      }
    },
  );
});

import { describe, it, expect } from "vitest";
import { buildAgentOptions } from "../../../src/adapter/tls-manager.js";

describe("buildAgentOptions", () => {
  it("returns empty options when TLS is disabled", () => {
    const opts = buildAgentOptions({ enabled: false, rejectUnauthorized: true });
    expect(opts).toEqual({});
  });

  it("sets rejectUnauthorized from TLS config", () => {
    const opts = buildAgentOptions({ enabled: true, rejectUnauthorized: false });
    expect((opts.connect as Record<string, unknown>).rejectUnauthorized).toBe(false);
  });

  it("does not set checkServerIdentity when fingerprint is absent", () => {
    const opts = buildAgentOptions({ enabled: true, rejectUnauthorized: true });
    expect((opts.connect as Record<string, unknown>).checkServerIdentity).toBeUndefined();
  });

  it("sets checkServerIdentity when fingerprint is provided", () => {
    const opts = buildAgentOptions({
      enabled: true,
      rejectUnauthorized: true,
      fingerprint: "aabbccddeeff",
    });
    expect((opts.connect as Record<string, unknown>).checkServerIdentity).toBeTypeOf("function");
  });

  it("checkServerIdentity returns undefined when fingerprint matches (colon-separated ok)", () => {
    const opts = buildAgentOptions({
      enabled: true,
      rejectUnauthorized: true,
      fingerprint: "aabbccddeeff",
    });
    const check = (opts.connect as Record<string, unknown>).checkServerIdentity as (
      host: string,
      cert: { fingerprint256: string },
    ) => Error | undefined;

    // cert.fingerprint256 uses colon notation; our code strips colons before comparing
    expect(check("router.local", { fingerprint256: "AA:BB:CC:DD:EE:FF" })).toBeUndefined();
  });

  it("checkServerIdentity returns Error when fingerprint does not match", () => {
    const opts = buildAgentOptions({
      enabled: true,
      rejectUnauthorized: true,
      fingerprint: "aabbccddeeff",
    });
    const check = (opts.connect as Record<string, unknown>).checkServerIdentity as (
      host: string,
      cert: { fingerprint256: string },
    ) => Error | undefined;

    expect(check("router.local", { fingerprint256: "11:22:33:44:55:66" })).toBeInstanceOf(Error);
  });
});

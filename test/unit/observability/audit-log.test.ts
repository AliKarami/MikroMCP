import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuditEvent } from "../../../src/types.js";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: "audit",
    ts: new Date().toISOString(),
    correlationId: "corr-123",
    identityId: "ci-pipeline",
    role: "operator",
    tool: "manage_firewall_rule",
    routerId: "edge-01",
    phase: "attempt",
    params: { routerId: "edge-01", action: "remove" },
    ...overrides,
  };
}

describe("auditLog — credential stripping", () => {
  it("strips password field from params at top level", async () => {
    vi.resetModules();
    const { redactParams } = await import("../../../src/observability/audit-log.js");
    const params = { routerId: "r", password: "hunter2", secret: "shh", token: "abc", authorization: "Bearer xyz", credentials: "creds", safe: "keep" };
    const redacted = redactParams(params);
    expect(redacted.password).toBeUndefined();
    expect(redacted.secret).toBeUndefined();
    expect(redacted.token).toBeUndefined();
    expect(redacted.authorization).toBeUndefined();
    expect(redacted.credentials).toBeUndefined();
    expect(redacted.safe).toBe("keep");
  });

  it("strips sensitive fields nested inside objects", async () => {
    vi.resetModules();
    const { redactParams } = await import("../../../src/observability/audit-log.js");
    const params = { nested: { password: "secret", value: 42 }, top: "ok" };
    const redacted = redactParams(params);
    expect((redacted.nested as Record<string, unknown>).password).toBeUndefined();
    expect((redacted.nested as Record<string, unknown>).value).toBe(42);
    expect(redacted.top).toBe("ok");
  });
});

describe("redactParams — crypto material", () => {
  it("strips VPN/crypto secret fields regardless of camelCase", async () => {
    vi.resetModules();
    const { redactParams } = await import("../../../src/observability/audit-log.js");
    const redacted = redactParams({
      routerId: "r1",
      privateKey: "WG-PRIVATE",
      preSharedKey: "PSK-VALUE",
      psk: "PSK2",
      passphrase: "p4ss",
      community: "SNMP-COMMUNITY",
      apiKey: "AK",
      keep: "visible",
    });
    expect(redacted.routerId).toBe("r1");
    expect(redacted.keep).toBe("visible");
    expect(redacted.privateKey).toBeUndefined();
    expect(redacted.preSharedKey).toBeUndefined();
    expect(redacted.psk).toBeUndefined();
    expect(redacted.passphrase).toBeUndefined();
    expect(redacted.community).toBeUndefined();
    expect(redacted.apiKey).toBeUndefined();
  });
});

describe("auditLog — file sink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mikromcp-audit-"));
  });

  it("writes NDJSON line to file when path is passed as second argument", async () => {
    vi.resetModules();
    const auditFile = join(dir, "audit.ndjson");
    const { auditLog } = await import("../../../src/observability/audit-log.js");
    const event = makeEvent({ phase: "success", durationMs: 42 });
    auditLog(event, auditFile);
    await vi.waitFor(() => {
      const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("audit");
      expect(parsed.phase).toBe("success");
      expect(parsed.durationMs).toBe(42);
      expect(parsed.identityId).toBe("ci-pipeline");
    });
  });

  it("does not write file when no path is passed", async () => {
    vi.resetModules();
    const { auditLog } = await import("../../../src/observability/audit-log.js");
    expect(() => auditLog(makeEvent())).not.toThrow();
  });
});

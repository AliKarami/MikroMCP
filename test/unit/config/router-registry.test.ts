import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RouterRegistry } from "../../../src/config/router-registry.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("../../../src/observability/logger.js", () => ({
  createLogger: () => ({ warn: warnSpy, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

function tempKey(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-key-"));
  const path = join(dir, "id_test");
  writeFileSync(path, "test-private-key", { mode });
  chmodSync(path, mode);
  return path;
}

function yamlWithKey(keyPath: string): string {
  return `
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
    sshUsername: automation
    sshPrivateKeyPath: ${keyPath}
`;
}

function tempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mikromcp-"));
  const path = join(dir, "routers.yaml");
  writeFileSync(path, content);
  return path;
}

const VALID_CONFIG = `
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
`;

describe("RouterRegistry", () => {
  it("loads a valid config without throwing", () => {
    const path = tempYaml(VALID_CONFIG);
    expect(() => new RouterRegistry(path)).not.toThrow();
  });

  it("exposes the loaded router by id", () => {
    const path = tempYaml(VALID_CONFIG);
    const registry = new RouterRegistry(path);
    expect(registry.getRouter("home").host).toBe("192.168.1.1");
  });

  it("throws a typed NOT_FOUND listing available routers for an unknown id", () => {
    const path = tempYaml(VALID_CONFIG);
    const registry = new RouterRegistry(path);
    try {
      registry.getRouter("nope");
      expect.unreachable("getRouter should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MikroMCPError);
      const error = err as MikroMCPError;
      expect(error.code).toBe("ROUTER_NOT_FOUND");
      expect(error.category).toBe(ErrorCategory.NOT_FOUND);
      expect(error.details).toMatchObject({ availableRouters: ["home"] });
    }
  });

  it("throws on missing required field (host)", () => {
    const path = tempYaml(`
routers:
  bad:
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: env
      envPrefix: ROUTER_BAD
    tags: []
    rosVersion: "7"
`);
    expect(() => new RouterRegistry(path)).toThrow(/host/i);
  });

  it("accepts optional tls.fingerprint field", () => {
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
      fingerprint: "aabbccddeeff001122334455"
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
`);
    const registry = new RouterRegistry(path);
    expect(registry.getRouter("home").tls.fingerprint).toBe("aabbccddeeff001122334455");
  });

  it("accepts optional sshFingerprint field", () => {
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
    sshFingerprint: "sha256hexvalue"
`);
    const registry = new RouterRegistry(path);
    expect(registry.getRouter("home").sshFingerprint).toBe("sha256hexvalue");
  });

  it("accepts a separate SSH username and absolute private-key path", () => {
    const keyPath = tempKey(0o600);
    const router = new RouterRegistry(tempYaml(yamlWithKey(keyPath))).getRouter("home");
    expect(router.sshUsername).toBe("automation");
    expect(router.sshPrivateKeyPath).toBe(keyPath);
  });

  it("rejects an sshPrivateKeyPath that cannot be read, at load time", () => {
    const path = tempYaml(yamlWithKey("/nonexistent/mikromcp/id_missing"));
    expect(() => new RouterRegistry(path)).toThrow(
      /home\.sshPrivateKeyPath: not readable \(ENOENT\)/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "warns when the private key is readable by group or others",
    () => {
      warnSpy.mockClear();
      const keyPath = tempKey(0o644);
      new RouterRegistry(tempYaml(yamlWithKey(keyPath)));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ routerId: "home", sshPrivateKeyPath: keyPath }),
        expect.stringMatching(/0600/),
      );
    },
  );

  it("does not warn about permissions for an owner-only private key", () => {
    warnSpy.mockClear();
    new RouterRegistry(tempYaml(yamlWithKey(tempKey(0o600))));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/0600/));
  });

  it("rejects a relative SSH private-key path", () => {
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
    sshPrivateKeyPath: .ssh/id_automation
`);
    expect(() => new RouterRegistry(path)).toThrow(/sshPrivateKeyPath must be absolute/);
  });

  it("soleRouterId returns the id when exactly one router is configured", () => {
    const registry = new RouterRegistry(tempYaml(VALID_CONFIG));
    expect(registry.soleRouterId()).toBe("home");
  });

  it("soleRouterId returns undefined when more than one router is configured", () => {
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    tags: []
    rosVersion: "7"
  office:
    host: 192.168.2.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: env
      envPrefix: ROUTER_OFFICE
    tags: []
    rosVersion: "7"
`);
    const registry = new RouterRegistry(path);
    expect(registry.soleRouterId()).toBeUndefined();
    expect(registry.routerIds().sort()).toEqual(["home", "office"]);
  });

  it("soleRouterId returns undefined when no routers are configured", () => {
    const registry = new RouterRegistry(join(tmpdir(), "does-not-exist.yaml"));
    expect(registry.soleRouterId()).toBeUndefined();
    expect(registry.routerIds()).toEqual([]);
  });

  it("throws on invalid port value", () => {
    const path = tempYaml(`
routers:
  bad:
    host: 192.168.1.1
    port: 99999
    tls:
      enabled: true
      rejectUnauthorized: false
    credentials:
      source: env
      envPrefix: ROUTER_BAD
    tags: []
    rosVersion: "7"
`);
    expect(() => new RouterRegistry(path)).toThrow();
  });

  it("loads a swos router without tls or rosVersion, defaulting deviceType", () => {
    const path = tempYaml(`
routers:
  switch:
    host: 192.168.88.2
    port: 80
    deviceType: swos
    credentials:
      source: env
      envPrefix: SWITCH_CORE
    tags: ["access"]
`);
    const registry = new RouterRegistry(path);
    const router = registry.getRouter("switch");
    expect(router.deviceType).toBe("swos");
    expect(router.rosVersion).toBe("swos");
    expect(router.tls.enabled).toBe(false);
  });

  it("normalises the swos-lite alias to the canonical swos platform", () => {
    // Both firmware editions speak the same API, so the tool gating must not
    // depend on which spelling the operator used.
    const path = tempYaml(`
routers:
  switch:
    host: 192.168.88.2
    port: 80
    deviceType: swos-lite
    credentials:
      source: env
      envPrefix: SWITCH_CORE
`);
    expect(new RouterRegistry(path).getRouter("switch").deviceType).toBe("swos");
  });

  it("defaults deviceType to routeros for existing configs", () => {
    const registry = new RouterRegistry(tempYaml(VALID_CONFIG));
    expect(registry.getRouter("home").deviceType).toBe("routeros");
    expect(registry.getRouter("home").rosVersion).toBe("7");
  });

  it("rejects an unknown deviceType", () => {
    const path = tempYaml(`
routers:
  weird:
    host: 192.168.1.1
    port: 80
    deviceType: banana
    credentials:
      source: env
      envPrefix: ROUTER_WEIRD
`);
    expect(() => new RouterRegistry(path)).toThrow(/deviceType/i);
  });

  it("still requires tls on RouterOS routers", () => {
    // Silently defaulting to tls.enabled=false would downgrade the router to
    // plaintext HTTP and send credentials in the clear.
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    credentials:
      source: env
      envPrefix: ROUTER_HOME
    rosVersion: "7"
`);
    expect(() => new RouterRegistry(path)).toThrow(/tls is required/);
  });

  it("still requires rosVersion on RouterOS routers", () => {
    const path = tempYaml(`
routers:
  home:
    host: 192.168.1.1
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_HOME
`);
    expect(() => new RouterRegistry(path)).toThrow(/rosVersion is required/);
  });

  it("rejects tls.enabled on a swos switch", () => {
    const path = tempYaml(`
routers:
  switch:
    host: 192.168.88.2
    port: 443
    deviceType: swos
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: SWITCH_CORE
`);
    expect(() => new RouterRegistry(path)).toThrow(/plain HTTP only/);
  });
});

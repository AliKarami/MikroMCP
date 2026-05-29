import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RouterRegistry } from "../../../src/config/router-registry.js";

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
});

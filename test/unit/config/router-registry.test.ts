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

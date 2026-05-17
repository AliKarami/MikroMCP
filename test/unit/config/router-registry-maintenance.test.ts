import { describe, it, expect, afterAll } from "vitest";
import { RouterRegistry } from "../../../src/config/router-registry.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "test-routers-mw.yaml");

function writeTmp(content: string) {
  writeFileSync(TMP, content, "utf-8");
}

describe("RouterRegistry — maintenanceWindows", () => {
  it("parses maintenanceWindows from YAML", () => {
    writeTmp(`
routers:
  edge-01:
    host: "10.0.0.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_EDGE01
    tags: []
    rosVersion: "7.14"
    maintenanceWindows:
      - days: ["Mon", "Wed", "Fri"]
        startTime: "02:00"
        endTime: "04:00"
        timezone: "Europe/Helsinki"
`);
    const reg = new RouterRegistry(TMP);
    const router = reg.getRouter("edge-01");
    expect(router.maintenanceWindows).toHaveLength(1);
    expect(router.maintenanceWindows![0].days).toEqual(["Mon", "Wed", "Fri"]);
    expect(router.maintenanceWindows![0].startTime).toBe("02:00");
    expect(router.maintenanceWindows![0].timezone).toBe("Europe/Helsinki");
  });

  it("defaults maintenanceWindows to undefined when not set", () => {
    writeTmp(`
routers:
  edge-01:
    host: "10.0.0.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: true
    credentials:
      source: env
      envPrefix: ROUTER_EDGE01
    tags: []
    rosVersion: "7.14"
`);
    const reg = new RouterRegistry(TMP);
    expect(reg.getRouter("edge-01").maintenanceWindows).toBeUndefined();
  });

  afterAll(() => {
    try {
      unlinkSync(TMP);
    } catch {}
  });
});

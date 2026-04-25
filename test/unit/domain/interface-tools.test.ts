import { describe, it, expect, vi } from "vitest";
import { interfaceTools } from "../../../src/domain/tools/interface-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import { z } from "zod";

const listInterfacesTool = interfaceTools[0];

function makeRouterConfig(): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
  };
}

function makeContext(ifaces: Record<string, unknown>[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    routerClient: {
      get: vi.fn().mockResolvedValue(ifaces),
    } as unknown as RouterOSRestClient,
  };
}

const listInterfacesInputSchema = z.object({
  routerId: z.string(),
  type: z.enum(["ether", "vlan", "bridge", "bonding", "wireguard", "gre", "all"]).default("all"),
  status: z.enum(["up", "down", "all"]).default("all"),
  macAddress: z.string().optional(),
  includeCounters: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

describe("list_interfaces", () => {
  describe("input schema", () => {
    it("accepts macAddress filter", () => {
      const r = listInterfacesInputSchema.parse({ routerId: "r", macAddress: "AA:BB:CC:DD:EE:FF" });
      expect(r.macAddress).toBe("AA:BB:CC:DD:EE:FF");
    });

    it("rejects extra fields", () => {
      expect(() => listInterfacesInputSchema.parse({ routerId: "r", unknown: 1 })).toThrow();
    });
  });

  describe("handler - macAddress filter", () => {
    const sampleIfaces = [
      { ".id": "*1", name: "ether1", type: "ether", running: "true", "mac-address": "AA:BB:CC:DD:EE:FF" },
      { ".id": "*2", name: "ether2", type: "ether", running: "true", "mac-address": "11:22:33:44:55:66" },
    ];

    it("returns only matching interface when macAddress filter is set", async () => {
      const ctx = makeContext(sampleIfaces);
      const result = await listInterfacesTool.handler({
        routerId: "test-router",
        macAddress: "AA:BB:CC:DD:EE:FF",
      }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.interfaces as unknown[]).length).toBe(1);
    });

    it("macAddress match is case-insensitive", async () => {
      const ctx = makeContext(sampleIfaces);
      const result = await listInterfacesTool.handler({
        routerId: "test-router",
        macAddress: "aa:bb:cc:dd:ee:ff",
      }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.interfaces as unknown[]).length).toBe(1);
    });

    it("returns empty when no interface matches macAddress", async () => {
      const ctx = makeContext(sampleIfaces);
      const result = await listInterfacesTool.handler({
        routerId: "test-router",
        macAddress: "FF:FF:FF:FF:FF:FF",
      }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.interfaces as unknown[]).length).toBe(0);
    });
  });
});

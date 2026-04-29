import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { bridgeTools } from "../../../src/domain/tools/bridge-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";

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

function makeContext(
  bridgeRecords: Record<string, unknown>[],
  portRecords: Record<string, unknown>[] = [],
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "corr",
    routerConfig: makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    routerClient: {
      get: vi.fn()
        .mockResolvedValueOnce(bridgeRecords)
        .mockResolvedValueOnce(portRecords),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listBridgesTool, manageBridgeTool, manageBridgePortTool] = bridgeTools;

describe("bridgeTools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => {
      expect(bridgeTools).toHaveLength(3);
    });
    it("list_bridges is readOnly", () => {
      expect(listBridgesTool.annotations.readOnlyHint).toBe(true);
    });
    it("manage_bridge is not readOnly", () => {
      expect(manageBridgeTool.annotations.readOnlyHint).toBe(false);
    });
  });

  describe("list_bridges", () => {
    it("returns bridges with port members joined", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", name: "bridge1", running: "true" }],
        [{ ".id": "*2", bridge: "bridge1", interface: "ether2" }],
      );
      const result = await listBridgesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const bridges = sc.bridges as Array<Record<string, unknown>>;
      expect(bridges).toHaveLength(1);
      const ports = bridges[0].ports as unknown[];
      expect(ports).toHaveLength(1);
    });
  });

  describe("manage_bridge", () => {
    it("dry-run returns action=dry_run without calling create", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler({
        routerId: "test-router",
        action: "create",
        name: "bridge2",
        dryRun: true,
      }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("returns already_exists when bridge exists with same name", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "bridge1" }]),
          create: vi.fn(),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler({
        routerId: "test-router",
        action: "create",
        name: "bridge1",
      }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });
  });

  describe("manage_bridge_port", () => {
    it("rejects extra fields", () => {
      const schema = z.object({
        routerId: z.string(),
        action: z.enum(["add", "remove"]),
        bridge: z.string(),
        interface: z.string(),
        dryRun: z.boolean().default(false),
      }).strict();
      expect(() => schema.parse({ routerId: "r", action: "add", bridge: "b", interface: "e", extra: 1 })).toThrow();
    });
  });
});

import { describe, it, expect, vi, type MockedFunction } from "vitest";
import { routeTools } from "../../../src/domain/tools/route-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const listRoutesTool = routeTools[0];
const manageRouteTool = routeTools[1];

// Inline schemas for isolated validation tests
const listRoutesInputSchema = z.object({
  routerId: z.string(),
  activeOnly: z.boolean().default(false),
  staticOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

const manageRouteInputSchema = z.object({
  routerId: z.string(),
  action: z.enum(["add", "remove"]),
  dstAddress: z.string()
    .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/, "Must be CIDR notation, e.g. 0.0.0.0/0"),
  gateway: z.string(),
  distance: z.number().int().min(1).max(255).default(1),
  comment: z.string().max(255).optional(),
  disabled: z.boolean().default(false),
  dryRun: z.boolean().default(false),
}).strict();

function makeContext(
  routes: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(routes);
  const mockCreate = vi.fn().mockResolvedValue(
    createReturn ?? { ".id": "*1", "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" },
  );
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: { get: mockGet, create: mockCreate, remove: mockRemove } as unknown as RouterOSRestClient,
  };
}

describe("route tools", () => {
  describe("metadata", () => {
    it("exports 2 tools: list_routes and manage_route", () => {
      expect(routeTools).toHaveLength(2);
      expect(listRoutesTool.name).toBe("list_routes");
      expect(manageRouteTool.name).toBe("manage_route");
    });

    it("list_routes has correct annotations", () => {
      expect(listRoutesTool.annotations.readOnlyHint).toBe(true);
      expect(listRoutesTool.annotations.destructiveHint).toBe(false);
      expect(listRoutesTool.annotations.idempotentHint).toBe(true);
      expect(listRoutesTool.annotations.openWorldHint).toBe(false);
    });

    it("manage_route has correct annotations", () => {
      expect(manageRouteTool.annotations.readOnlyHint).toBe(false);
      expect(manageRouteTool.annotations.destructiveHint).toBe(true);
      expect(manageRouteTool.annotations.idempotentHint).toBe(true);
      expect(manageRouteTool.annotations.openWorldHint).toBe(false);
    });
  });

  describe("list_routes input schema", () => {
    it("accepts minimal input with correct defaults", () => {
      const r = listRoutesInputSchema.parse({ routerId: "core-01" });
      expect(r.activeOnly).toBe(false);
      expect(r.staticOnly).toBe(false);
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });

    it("rejects extra fields", () => {
      expect(() => listRoutesInputSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("manage_route input schema", () => {
    it("accepts valid add action", () => {
      const r = manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
      });
      expect(r.action).toBe("add");
      expect(r.distance).toBe(1);
      expect(r.disabled).toBe(false);
    });

    it("rejects dstAddress without prefix", () => {
      expect(() => manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.0.0.0",
        gateway: "192.168.1.1",
      })).toThrow();
    });

    it("rejects distance 0 and 256", () => {
      expect(() => manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
        distance: 0,
      })).toThrow();
      expect(() => manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
        distance: 256,
      })).toThrow();
    });

    it("rejects action 'update'", () => {
      expect(() => manageRouteInputSchema.parse({
        routerId: "r",
        action: "update" as unknown,
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
      })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
        unknownField: true,
      })).toThrow();
    });
  });

  describe("list_routes handler", () => {
    const sampleRoutes = [
      { ".id": "*1", "dst-address": "10.0.0.0/8", gateway: "192.168.1.1", distance: "20", active: "true", dynamic: "false" },
      { ".id": "*2", "dst-address": "172.16.0.0/12", gateway: "192.168.1.2", distance: "10", active: "false", dynamic: "false" },
      { ".id": "*3", "dst-address": "0.0.0.0/0", gateway: "192.168.1.254", active: "true", dynamic: "true" },
    ];

    it("returns all routes with correct total", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Record<string, unknown>).total).toBe(3);
      expect(((result.structuredContent as Record<string, unknown>).routes as unknown[]).length).toBe(3);
    });

    it("filters by activeOnly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler({ routerId: "test-router", activeOnly: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
      expect((sc.routes as unknown[]).length).toBe(2);
    });

    it("filters by staticOnly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler({ routerId: "test-router", staticOnly: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
      expect((sc.routes as unknown[]).length).toBe(2);
    });

    it("paginates correctly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler({ routerId: "test-router", limit: 2, offset: 0 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(3);
      expect((sc.routes as unknown[]).length).toBe(2);
      expect(sc.hasMore).toBe(true);
    });

    it("formats route information correctly in content", async () => {
      const ctx = makeContext([sampleRoutes[0]]);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).toContain("10.0.0.0/8");
      expect(result.content).toContain("192.168.1.1");
      expect(result.content).toContain("[20]");
      expect(result.content).toContain("ACTIVE");
    });

    it("includes DYNAMIC flag only when set", async () => {
      const ctx = makeContext([sampleRoutes[2]]);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).toContain("DYNAMIC");
    });
  });

  describe("manage_route handler - add action", () => {
    const sampleRoute = { ".id": "*1", "dst-address": "10.0.0.0/8", gateway: "192.168.1.1", distance: "1", disabled: "false" };

    it("creates route when no match found", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler({
        routerId: "test-router",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "created");
      expect((ctx.routerClient as Record<string, unknown>).create).toHaveBeenCalled();
    });

    it("returns already_exists when match found", async () => {
      const ctx = makeContext([sampleRoute]);
      const result = await manageRouteTool.handler({
        routerId: "test-router",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });

    it("returns dry_run when dryRun is true", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler({
        routerId: "test-router",
        action: "add",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
        dryRun: true,
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });
  });

  describe("manage_route handler - remove action", () => {
    const sampleRoute = { ".id": "*1", "dst-address": "10.0.0.0/8", gateway: "192.168.1.1", distance: "1" };

    it("removes route when match found", async () => {
      const ctx = makeContext([sampleRoute]);
      const result = await manageRouteTool.handler({
        routerId: "test-router",
        action: "remove",
        dstAddress: "10.0.0.0/8",
        gateway: "192.168.1.1",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "removed");
      expect((ctx.routerClient as Record<string, unknown>).remove).toHaveBeenCalled();
    });

    it("throws NOT_FOUND when no match", async () => {
      const ctx = makeContext([]);
      await expect(
        manageRouteTool.handler({
          routerId: "test-router",
          action: "remove",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
        }, ctx),
      ).rejects.toThrow();
    });
  });
});

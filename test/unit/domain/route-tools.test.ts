import { describe, it, expect, vi, type MockedFunction } from "vitest";
import { routeTools } from "../../../src/domain/tools/route-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { snapshotPathsFor } from "../../../src/domain/tools/tool-definition.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { fromWire } from "../helpers/wire.js";

const listRoutesTool = routeTools[0];
const manageRouteTool = routeTools[1];

const listRoutesInputSchema = listRoutesTool.inputSchema;

const manageRouteInputSchema = manageRouteTool.inputSchema;

function makeContext(
  routes: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(routes);
  const mockCreate = vi
    .fn()
    .mockResolvedValue(
      createReturn ?? { ".id": "*1", "dst-address": "0.0.0.0/0", gateway: "1.1.1.1" },
    );
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: mockGet,
      create: mockCreate,
      remove: mockRemove,
    } as unknown as RouterOSRestClient,
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

    it("accepts optional routingTable", () => {
      const r = manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "0.0.0.0/0",
        gateway: "10.0.0.1",
        routingTable: "vpn",
      });
      expect(r.routingTable).toBe("vpn");
    });

    it("accepts plain IP dstAddress and transforms to /32", () => {
      const r = manageRouteInputSchema.parse({
        routerId: "r",
        action: "add",
        dstAddress: "10.77.0.4",
        gateway: "192.168.1.1",
      });
      expect(r.dstAddress).toBe("10.77.0.4/32");
    });

    it("rejects distance 0 and 256", () => {
      expect(() =>
        manageRouteInputSchema.parse({
          routerId: "r",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          distance: 0,
        }),
      ).toThrow();
      expect(() =>
        manageRouteInputSchema.parse({
          routerId: "r",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          distance: 256,
        }),
      ).toThrow();
    });

    it("rejects action 'update'", () => {
      expect(() =>
        manageRouteInputSchema.parse({
          routerId: "r",
          action: "update" as unknown,
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
        }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageRouteInputSchema.parse({
          routerId: "r",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          unknownField: true,
        }),
      ).toThrow();
    });
  });

  describe("list_routes handler", () => {
    const sampleRoutes = [
      {
        ".id": "*1",
        "dst-address": "10.0.0.0/8",
        gateway: "192.168.1.1",
        distance: "20",
        active: "true",
        dynamic: "false",
      },
      {
        ".id": "*2",
        "dst-address": "172.16.0.0/12",
        gateway: "192.168.1.2",
        distance: "10",
        active: "false",
        dynamic: "false",
      },
      {
        ".id": "*3",
        "dst-address": "0.0.0.0/0",
        gateway: "192.168.1.254",
        active: "true",
        dynamic: "true",
      },
    ];

    it("returns all routes with correct total", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Record<string, unknown>).total).toBe(3);
      expect(
        ((result.structuredContent as Record<string, unknown>).routes as unknown[]).length,
      ).toBe(3);
    });

    it("filters by activeOnly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler(
        { routerId: "test-router", activeOnly: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
      expect((sc.routes as unknown[]).length).toBe(2);
    });

    it("filters by staticOnly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler(
        { routerId: "test-router", staticOnly: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
      expect((sc.routes as unknown[]).length).toBe(2);
    });

    it("paginates correctly", async () => {
      const ctx = makeContext(sampleRoutes);
      const result = await listRoutesTool.handler(
        { routerId: "test-router", limit: 2, offset: 0 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(3);
      expect((sc.routes as unknown[]).length).toBe(2);
      expect(sc.hasMore).toBe(true);
    });

    it("returns route information in structuredContent", async () => {
      const ctx = makeContext([sampleRoutes[0]]);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const route = (sc.routes as Record<string, unknown>[])[0];
      expect(route["dst-address"]).toBe("10.0.0.0/8");
      expect(route.gateway).toBe("192.168.1.1");
    });

    it("returns a header plus itemized rows in content", async () => {
      const ctx = makeContext([sampleRoutes[0]]);
      const result = await listRoutesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).toContain("Routes on test-router: 1-1 of 1.");
      expect(result.content).toContain("dst-address=10.0.0.0/8");
      expect(result.content).toContain("gateway=192.168.1.1");
    });
  });

  describe("manage_route handler - add action", () => {
    const sampleRoute = {
      ".id": "*1",
      "dst-address": "10.0.0.0/8",
      gateway: "192.168.1.1",
      distance: "1",
      disabled: "false",
    };

    it("creates route when no match found", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler(
        {
          routerId: "test-router",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "created");
      expect((ctx.routerClient as Record<string, unknown>).create).toHaveBeenCalled();
    });

    it("returns already_exists when match found with same distance and disabled", async () => {
      const ctx = makeContext([sampleRoute]);
      const result = await manageRouteTool.handler(
        {
          routerId: "test-router",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          distance: 1,
          disabled: false,
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });

    it("returns already_exists when the record carries parsed number/boolean fields", async () => {
      // The response parser converts wire strings ("1", "false") to typed
      // values — the idempotency check must not report a false conflict.
      const ctx = makeContext([{ ...sampleRoute, distance: 1, disabled: false }]);
      const result = await manageRouteTool.handler(
        {
          routerId: "test-router",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          distance: 1,
          disabled: false,
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when match found but distance differs", async () => {
      const ctx = makeContext([sampleRoute]);
      await expect(
        manageRouteTool.handler(
          {
            routerId: "test-router",
            action: "add",
            dstAddress: "10.0.0.0/8",
            gateway: "192.168.1.1",
            distance: 5,
            disabled: false,
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("throws CONFLICT when match found but disabled differs", async () => {
      const ctx = makeContext([sampleRoute]);
      await expect(
        manageRouteTool.handler(
          {
            routerId: "test-router",
            action: "add",
            dstAddress: "10.0.0.0/8",
            gateway: "192.168.1.1",
            distance: 1,
            disabled: true,
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("returns dry_run when dryRun is true", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler(
        {
          routerId: "test-router",
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
          dryRun: true,
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });
  });

  describe("manage_route handler - remove action", () => {
    const sampleRoute = {
      ".id": "*1",
      "dst-address": "10.0.0.0/8",
      gateway: "192.168.1.1",
      distance: "1",
    };

    it("removes route when match found", async () => {
      const ctx = makeContext([sampleRoute]);
      const result = await manageRouteTool.handler(
        {
          routerId: "test-router",
          action: "remove",
          dstAddress: "10.0.0.0/8",
          gateway: "192.168.1.1",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "removed");
      expect((ctx.routerClient as Record<string, unknown>).remove).toHaveBeenCalled();
    });

    it("throws NOT_FOUND when no match", async () => {
      const ctx = makeContext([]);
      await expect(
        manageRouteTool.handler(
          {
            routerId: "test-router",
            action: "remove",
            dstAddress: "10.0.0.0/8",
            gateway: "192.168.1.1",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  describe("family: ipv6", () => {
    const ipv6Route = {
      ".id": "*A",
      "dst-address": "2001:db8:100::/48",
      gateway: "fe80::1%ether1",
      distance: "1",
      disabled: "false",
      dynamic: "false",
      active: "true",
    };
    const add = {
      routerId: "test-router",
      action: "add",
      family: "ipv6",
      dstAddress: "2001:db8:100::/48",
      gateway: "fe80::1%ether1",
    };

    it("defaults family to ip on both tools", () => {
      expect(listRoutesInputSchema.parse({}).family).toBe("ip");
      expect(
        manageRouteInputSchema.parse({
          action: "add",
          dstAddress: "10.0.0.0/8",
          gateway: "1.1.1.1",
        }).family,
      ).toBe("ip");
      expect(() => listRoutesInputSchema.parse({ family: "inet6" })).toThrow();
    });

    it("normalises an IPv6 destination and makes a bare address /128", () => {
      expect(
        manageRouteInputSchema.parse({ ...add, dstAddress: "2001:DB8:100:0::/48" }).dstAddress,
      ).toBe("2001:db8:100::/48");
      expect(manageRouteInputSchema.parse({ ...add, dstAddress: "2001:db8::5" }).dstAddress).toBe(
        "2001:db8::5/128",
      );
    });

    it("snapshots the path of the chosen family", () => {
      expect(snapshotPathsFor(manageRouteTool, {})).toEqual(["ip/route"]);
      expect(snapshotPathsFor(manageRouteTool, { family: "ip" })).toEqual(["ip/route"]);
      expect(snapshotPathsFor(manageRouteTool, { family: "ipv6" })).toEqual(["ipv6/route"]);
    });

    it("list_routes reads ipv6/route", async () => {
      const ctx = makeContext(fromWire([ipv6Route]));
      const result = await listRoutesTool.handler({ family: "ipv6" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith("ipv6/route", {
        limit: undefined,
        offset: undefined,
      });
      expect(result.content).toContain("IPv6 routes on test-router: 1-1 of 1.");
      expect(result.content).toContain("dst-address=2001:db8:100::/48 gateway=fe80::1%ether1");
      expect(result.structuredContent.family).toBe("ipv6");
    });

    it("creates the route on ipv6/route", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler(add, ctx);
      expect(result.structuredContent.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("ipv6/route", {
        "dst-address": "2001:db8:100::/48",
        gateway: "fe80::1%ether1",
        distance: "1",
        disabled: "false",
      });
    });

    it("returns already_exists for the same route written differently", async () => {
      const ctx = makeContext(fromWire([ipv6Route]));
      const result = await manageRouteTool.handler(
        { ...add, dstAddress: "2001:0DB8:0100::/48", gateway: "FE80:0::1%ether1" },
        ctx,
      );
      expect(result.structuredContent.action).toBe("already_exists");
      expect(ctx.routerClient.get).toHaveBeenCalledWith("ipv6/route", {
        filter: { "dst-address": "2001:db8:100::/48" },
      });
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when the IPv6 route differs", async () => {
      const ctx = makeContext(fromWire([ipv6Route]));
      await expect(manageRouteTool.handler({ ...add, distance: 10 }, ctx)).rejects.toMatchObject({
        category: ErrorCategory.CONFLICT,
        code: "ROUTE_CONFLICT",
      });
    });

    it("treats a link-local gateway on another interface as a different route", async () => {
      const ctx = makeContext(fromWire([ipv6Route]));
      const result = await manageRouteTool.handler({ ...add, gateway: "fe80::1%ether2" }, ctx);
      expect(result.structuredContent.action).toBe("created");
    });

    it("accepts a global gateway and an interface name", async () => {
      const ctx = makeContext([]);
      await manageRouteTool.handler({ ...add, gateway: "2001:DB8::1", dryRun: true }, ctx);
      const viaIface = await manageRouteTool.handler({ ...add, gateway: "pppoe-out1" }, ctx);
      expect(viaIface.structuredContent.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledTimes(1);
    });

    it("dry run normalises the gateway in the diff", async () => {
      const ctx = makeContext([]);
      const result = await manageRouteTool.handler(
        { ...add, gateway: "2001:DB8:0::1", dryRun: true },
        ctx,
      );
      expect(result.structuredContent.diff).toContainEqual({
        property: "gateway",
        before: null,
        after: "2001:db8::1",
      });
    });

    it("removes from ipv6/route", async () => {
      const ctx = makeContext(fromWire([ipv6Route]));
      const result = await manageRouteTool.handler({ ...add, action: "remove" }, ctx);
      expect(result.structuredContent.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ipv6/route", "*A");
    });

    it("throws NOT_FOUND removing a missing IPv6 route", async () => {
      const ctx = makeContext([]);
      await expect(
        manageRouteTool.handler({ ...add, action: "remove" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it.each([
      [{ dstAddress: "10.0.0.0/8" }, "ROUTE_FAMILY_MISMATCH"],
      [{ gateway: "192.0.2.1" }, "ROUTE_FAMILY_MISMATCH"],
      [{ gateway: "fe80::1" }, "ROUTE_LINK_LOCAL_GATEWAY_NEEDS_INTERFACE"],
      [{ gateway: "2001:db8::zz" }, "ROUTE_INVALID_GATEWAY"],
      [{ gateway: "fe80::1%" }, "ROUTE_INVALID_GATEWAY"],
      [{ gateway: "ether1%ether2" }, "ROUTE_INVALID_GATEWAY"],
    ])("rejects %o with %s before touching the router", async (override, code) => {
      const ctx = makeContext([]);
      await expect(manageRouteTool.handler({ ...add, ...override }, ctx)).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
        code,
      });
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
    });

    it("rejects IPv6 values on an ip-family route", async () => {
      const ctx = makeContext([]);
      const v4 = { routerId: "test-router", action: "add" };
      await expect(
        manageRouteTool.handler({ ...v4, dstAddress: "2001:db8::/32", gateway: "ether1" }, ctx),
      ).rejects.toMatchObject({ code: "ROUTE_FAMILY_MISMATCH" });
      await expect(
        manageRouteTool.handler({ ...v4, dstAddress: "10.0.0.0/8", gateway: "2001:db8::1" }, ctx),
      ).rejects.toMatchObject({ code: "ROUTE_FAMILY_MISMATCH" });
    });
  });
});

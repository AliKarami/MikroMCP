import { describe, it, expect, vi } from "vitest";
import { dhcpTools } from "../../../src/domain/tools/dhcp-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { z } from "zod";

const listTool = dhcpTools[0];

// Inline schema for isolated validation tests (avoids importing internal implementation detail)
const listDhcpInputSchema = z
  .object({
    routerId: z.string(),
    server: z.string().optional(),
    status: z.enum(["bound", "waiting", "offered", "blocked", "all"]).default("all"),
    macAddress: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

function makeContext(leases: Record<string, unknown>[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(leases),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

describe("list_dhcp_leases tool", () => {
  describe("metadata", () => {
    it("has correct name and annotations", () => {
      expect(listTool.name).toBe("list_dhcp_leases");
      expect(listTool.annotations.readOnlyHint).toBe(true);
      expect(listTool.annotations.destructiveHint).toBe(false);
      expect(listTool.annotations.idempotentHint).toBe(true);
      expect(listTool.annotations.openWorldHint).toBe(false);
    });
  });

  describe("input schema", () => {
    it("accepts minimal input with correct defaults", () => {
      const r = listDhcpInputSchema.parse({ routerId: "core-01" });
      expect(r.status).toBe("all");
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });

    it("accepts all optional fields", () => {
      const r = listDhcpInputSchema.parse({
        routerId: "core-01",
        server: "dhcp1",
        status: "bound",
        macAddress: "AA:BB:CC:DD:EE:FF",
        limit: 50,
        offset: 10,
      });
      expect(r.server).toBe("dhcp1");
      expect(r.status).toBe("bound");
      expect(r.limit).toBe(50);
    });

    it("rejects unknown status", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", status: "expired" })).toThrow();
    });

    it("rejects limit 0 and 501", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", limit: 0 })).toThrow();
      expect(() => listDhcpInputSchema.parse({ routerId: "r", limit: 501 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("handler", () => {
    const sampleLeases = [
      {
        ".id": "*1",
        address: "192.168.1.10",
        "mac-address": "AA:BB:CC:DD:EE:01",
        "host-name": "laptop",
        server: "dhcp1",
        status: "bound",
      },
      {
        ".id": "*2",
        address: "192.168.1.11",
        "mac-address": "AA:BB:CC:DD:EE:02",
        server: "dhcp1",
        status: "waiting",
      },
      {
        ".id": "*3",
        address: "192.168.1.12",
        "mac-address": "AA:BB:CC:DD:EE:03",
        "host-name": "phone",
        server: "dhcp2",
        status: "bound",
      },
    ];

    it("returns all leases with no filters", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Record<string, unknown>).total).toBe(3);
      expect(
        ((result.structuredContent as Record<string, unknown>).leases as unknown[]).length,
      ).toBe(3);
    });

    it("filters by status", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await listTool.handler({ routerId: "test-router", status: "bound" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by server", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await listTool.handler({ routerId: "test-router", server: "dhcp2" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(1);
    });

    it("filters by macAddress (case-insensitive)", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await listTool.handler(
        { routerId: "test-router", macAddress: "aa:bb:cc:dd:ee:01" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).total).toBe(1);
    });

    it("paginates and sets hasMore", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await listTool.handler({ routerId: "test-router", limit: 2, offset: 0 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(3);
      expect((sc.leases as unknown[]).length).toBe(2);
      expect(sc.hasMore).toBe(true);
    });

    it("returns host-name in structuredContent when present", async () => {
      const ctx = makeContext([sampleLeases[0]]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const lease = (sc.leases as Record<string, unknown>[])[0];
      expect(lease["host-name"]).toBe("laptop");
    });

    it("omits host-name in content when missing", async () => {
      const ctx = makeContext([sampleLeases[1]]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).not.toContain("undefined");
      expect(result.content).not.toContain("()");
    });
  });
});

describe("list_dhcp_leases - leaseType filter", () => {
  const leases = [
    {
      ".id": "*1",
      address: "192.168.1.10",
      "mac-address": "AA:BB:CC:DD:EE:01",
      status: "bound",
      dynamic: "true",
    },
    {
      ".id": "*2",
      address: "192.168.1.20",
      "mac-address": "AA:BB:CC:DD:EE:02",
      status: "bound",
      dynamic: "false",
    },
  ];

  it("filters dynamic leases", async () => {
    const ctx = makeContext(leases);
    const result = await listTool.handler({ routerId: "test-router", leaseType: "dynamic" }, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.leases as unknown[]).length).toBe(1);
  });

  it("filters static leases", async () => {
    const ctx = makeContext(leases);
    const result = await listTool.handler({ routerId: "test-router", leaseType: "static" }, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.leases as unknown[]).length).toBe(1);
  });

  it("returns all when leaseType is all", async () => {
    const ctx = makeContext(leases);
    const result = await listTool.handler({ routerId: "test-router", leaseType: "all" }, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.leases as unknown[]).length).toBe(2);
  });
});

describe("manage_dhcp_lease", () => {
  it("tool is named manage_dhcp_lease", () => expect(dhcpTools[1].name).toBe("manage_dhcp_lease"));
  it("is not readOnly", () => expect(dhcpTools[1].annotations.readOnlyHint).toBe(false));
  it("has snapshotPaths", () =>
    expect(dhcpTools[1].snapshotPaths).toContain("ip/dhcp-server/lease"));

  it("make-static converts dynamic lease", async () => {
    const dynamicLease = {
      ".id": "*1",
      "mac-address": "AA:BB:CC:DD:EE:01",
      address: "192.168.1.10",
      dynamic: "true",
    };
    const ctx = makeContext([dynamicLease]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "make-static", macAddress: "AA:BB:CC:DD:EE:01" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("made-static");
    expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/dhcp-server/lease", "*1", {
      dynamic: "false",
    });
  });

  it("throws NOT_FOUND when MAC not in lease table", async () => {
    const ctx = makeContext([]);
    await expect(
      dhcpTools[1].handler(
        { routerId: "test-router", action: "make-static", macAddress: "FF:FF:FF:FF:FF:FF" },
        ctx,
      ),
    ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
  });

  it("removes lease by MAC address", async () => {
    const lease = { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:01", address: "192.168.1.10" };
    const ctx = makeContext([lease]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "remove", macAddress: "AA:BB:CC:DD:EE:01" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("removed");
    expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/dhcp-server/lease", "*1");
  });

  it("returns not_found on remove when MAC missing", async () => {
    const ctx = makeContext([]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "remove", macAddress: "FF:FF:FF:FF:FF:FF" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("not_found");
  });

  it("dry_run for make-static returns diff without updating", async () => {
    const dynamicLease = {
      ".id": "*1",
      "mac-address": "AA:BB:CC:DD:EE:01",
      address: "192.168.1.10",
      dynamic: "true",
    };
    const ctx = makeContext([dynamicLease]);
    const result = await dhcpTools[1].handler(
      {
        routerId: "test-router",
        action: "make-static",
        macAddress: "AA:BB:CC:DD:EE:01",
        dryRun: true,
      },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("dry_run");
    expect(ctx.routerClient.update).not.toHaveBeenCalled();
  });

  it("dry_run for remove returns diff without removing", async () => {
    const lease = { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:01", address: "192.168.1.10" };
    const ctx = makeContext([lease]);
    const result = await dhcpTools[1].handler(
      {
        routerId: "test-router",
        action: "remove",
        macAddress: "AA:BB:CC:DD:EE:01",
        dryRun: true,
      },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("dry_run");
    expect(ctx.routerClient.remove).not.toHaveBeenCalled();
  });

  it("MAC address matching is case-insensitive", async () => {
    const lease = { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:01", address: "192.168.1.10" };
    const ctx = makeContext([lease]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "remove", macAddress: "aa:bb:cc:dd:ee:01" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("removed");
  });

  it("returns already_static when lease is already static (dynamic: false)", async () => {
    const staticLease = { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:01", address: "192.168.1.10", dynamic: "false" };
    const ctx = makeContext([staticLease]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "make-static", macAddress: "AA:BB:CC:DD:EE:01" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("already_static");
    expect(ctx.routerClient.update).not.toHaveBeenCalled();
  });

  it("returns already_static when lease is already static (dynamic: boolean false)", async () => {
    const staticLease = { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:01", address: "192.168.1.10", dynamic: false };
    const ctx = makeContext([staticLease]);
    const result = await dhcpTools[1].handler(
      { routerId: "test-router", action: "make-static", macAddress: "AA:BB:CC:DD:EE:01" },
      ctx,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.action).toBe("already_static");
    expect(ctx.routerClient.update).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import { ipPoolTools } from "../../../src/domain/tools/ip-pool-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

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

function makeContext(records: Record<string, unknown>[] = []): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: { upload: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "pool1", ranges: "192.168.1.100-192.168.1.200" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = ipPoolTools;

describe("ipPoolTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(ipPoolTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_ip_pools");
      expect(manageTool.name).toBe("manage_ip_pool");
    });
    it("list_ip_pools is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_ip_pool is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("manage_ip_pool has snapshotPaths", () => expect(manageTool.snapshotPaths).toContain("ip/pool"));
  });

  describe("list_ip_pools handler", () => {
    it("returns pools from ip/pool", async () => {
      const pools = [
        { ".id": "*1", name: "pool1", ranges: "192.168.1.100-192.168.1.200" },
        { ".id": "*2", name: "pool2", ranges: "10.0.0.10-10.0.0.50" },
      ];
      const ctx = makeContext(pools);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.pools as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by name substring", async () => {
      const pools = [
        { ".id": "*1", name: "pool-lan", ranges: "192.168.1.100-192.168.1.200" },
        { ".id": "*2", name: "pool-wan", ranges: "10.0.0.10-10.0.0.50" },
      ];
      const ctx = makeContext(pools);
      const result = await listTool.handler({ routerId: "test-router", name: "lan" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.pools as unknown[]).length).toBe(1);
    });

    it("respects limit and offset", async () => {
      const pools = Array.from({ length: 5 }, (_, i) => ({
        ".id": `*${i}`,
        name: `pool${i}`,
        ranges: `192.168.${i}.1-192.168.${i}.100`,
      }));
      const ctx = makeContext(pools);
      const result = await listTool.handler({ routerId: "test-router", limit: 2, offset: 1 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.pools as unknown[]).length).toBe(2);
      expect(sc.total).toBe(5);
      expect(sc.hasMore).toBe(true);
    });
  });

  describe("manage_ip_pool handler - add", () => {
    it("creates pool when not existing", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pool1", ranges: "192.168.1.100-192.168.1.200" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
    });

    it("returns already_exists when pool with same name and ranges exists", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "pool1", ranges: "192.168.1.100-192.168.1.200" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pool1", ranges: "192.168.1.100-192.168.1.200" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("throws CONFLICT when pool exists with different ranges", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "pool1", ranges: "10.0.0.1-10.0.0.100" }]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "pool1", ranges: "192.168.1.100-192.168.1.200" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION when ranges missing on add", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "add", name: "pool1" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("dry_run returns diff without creating", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pool1", ranges: "192.168.1.100-192.168.1.200", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("includes next-pool in body when nextPool is provided", async () => {
      const ctx = makeContext([]);
      await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pool1", ranges: "192.168.1.100-192.168.1.200", nextPool: "pool2" },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "ip/pool",
        expect.objectContaining({ "next-pool": "pool2" }),
      );
    });
  });

  describe("manage_ip_pool handler - remove", () => {
    it("removes existing pool", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "pool1", ranges: "192.168.1.100-192.168.1.200" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "pool1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/pool", "*1");
    });

    it("returns not_found when pool missing", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "missing" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "pool1", ranges: "192.168.1.100-192.168.1.200" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "pool1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });
});

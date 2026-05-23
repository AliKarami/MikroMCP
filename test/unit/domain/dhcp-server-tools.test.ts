import { describe, it, expect, vi } from "vitest";
import { dhcpServerTools } from "../../../src/domain/tools/dhcp-server-tools.js";
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
    identity: {
      id: "superadmin-builtin",
      role: "superadmin" as const,
      allowedRouters: [],
      allowedToolPatterns: [],
    },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listServersTool, manageServerTool] = dhcpServerTools;

describe("dhcpServerTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(dhcpServerTools).toHaveLength(2));

    it("has correct tool names", () => {
      expect(listServersTool.name).toBe("list_dhcp_servers");
      expect(manageServerTool.name).toBe("manage_dhcp_server");
    });

    it("list_dhcp_servers is readOnly", () =>
      expect(listServersTool.annotations.readOnlyHint).toBe(true));

    it("manage_dhcp_server is not readOnly", () =>
      expect(manageServerTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema — list_dhcp_servers", () => {
    it("parses valid input", () => {
      const result = listServersTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listServersTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listServersTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listServersTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_dhcp_server", () => {
    it("parses valid add input", () => {
      const result = manageServerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "dhcp1",
        interface: "bridge",
        addressPool: "pool1",
      });
      expect(result.success).toBe(true);
    });

    it("applies default dryRun=false", () => {
      const result = manageServerTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        name: "dhcp1",
      });
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageServerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "dhcp1",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageServerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        name: "dhcp1",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_dhcp_servers", () => {
    it("returns servers in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "dhcp1", interface: "bridge", "address-pool": "pool1" },
        { ".id": "*2", name: "dhcp2", interface: "ether1", "address-pool": "pool2" },
      ]);
      const result = await listServersTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by interface exact match", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "dhcp1", interface: "bridge" },
        { ".id": "*2", name: "dhcp2", interface: "ether1" },
      ]);
      const result = await listServersTool.handler(
        { routerId: "test-router", interface: "bridge" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(1);
    });

    it("does not partially match interface", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "dhcp1", interface: "bridge1" },
        { ".id": "*2", name: "dhcp2", interface: "bridge2" },
      ]);
      const result = await listServersTool.handler(
        { routerId: "test-router", interface: "bridge" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(0);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "dhcp1" },
        { ".id": "*2", name: "dhcp2" },
        { ".id": "*3", name: "dhcp3" },
      ]);
      const result = await listServersTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });

    it("respects limit — returns up to limit servers", async () => {
      const servers = Array.from({ length: 5 }, (_, i) => ({
        ".id": `*${i}`,
        name: `dhcp${i}`,
        interface: `ether${i}`,
        "address-pool": `pool${i}`,
        disabled: "false",
      }));
      const ctx = makeContext(servers);
      const result = await listServersTool.handler({ routerId: "test-router", limit: 2 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(2);
      expect(sc.total).toBe(5);
      expect(sc.hasMore).toBe(true);
    });

    it("respects offset pagination", async () => {
      const servers = Array.from({ length: 5 }, (_, i) => ({
        ".id": `*${i}`,
        name: `dhcp${i}`,
        interface: `ether${i}`,
        "address-pool": `pool${i}`,
        disabled: "false",
      }));
      const ctx = makeContext(servers);
      const result = await listServersTool.handler({ routerId: "test-router", limit: 2, offset: 3 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.servers as unknown[]).length).toBe(2);
      expect(sc.offset).toBe(3);
      expect(sc.hasMore).toBe(false);
    });
  });

  describe("handler — manage_dhcp_server add", () => {
    it("creates server when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageServerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "dhcp1",
          interface: "bridge",
          addressPool: "pool1",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "ip/dhcp-server",
        expect.objectContaining({ name: "dhcp1", interface: "bridge", "address-pool": "pool1" }),
      );
    });

    it("returns already_exists when server has same interface and pool", async () => {
      const ctx = makeContext([
        {
          ".id": "*1",
          name: "dhcp1",
          interface: "bridge",
          "address-pool": "pool1",
        },
      ]);
      const result = await manageServerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "dhcp1",
          interface: "bridge",
          addressPool: "pool1",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when server exists with different config", async () => {
      const ctx = makeContext([
        {
          ".id": "*1",
          name: "dhcp1",
          interface: "ether1",
          "address-pool": "pool2",
        },
      ]);
      await expect(
        manageServerTool.handler(
          {
            routerId: "test-router",
            action: "add",
            name: "dhcp1",
            interface: "bridge",
            addressPool: "pool1",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION error when interface is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageServerTool.handler(
          { routerId: "test-router", action: "add", name: "dhcp1", addressPool: "pool1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "DHCP_SERVER_INTERFACE_REQUIRED" });
    });

    it("throws VALIDATION error when addressPool is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageServerTool.handler(
          { routerId: "test-router", action: "add", name: "dhcp1", interface: "bridge" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "DHCP_SERVER_POOL_REQUIRED" });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageServerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "dhcp1",
          interface: "bridge",
          addressPool: "pool1",
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("includes leaseTime in body when provided", async () => {
      const ctx = makeContext([]);
      await manageServerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "dhcp1",
          interface: "bridge",
          addressPool: "pool1",
          leaseTime: "1d",
        },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "ip/dhcp-server",
        expect.objectContaining({ "lease-time": "1d" }),
      );
    });
  });

  describe("handler — manage_dhcp_server remove", () => {
    it("removes server when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "dhcp1", interface: "bridge" }]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "remove", name: "dhcp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/dhcp-server", "*1");
    });

    it("returns not_found when server already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "remove", name: "dhcp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "dhcp1" }]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "remove", name: "dhcp1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_dhcp_server enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "dhcp1", disabled: "true" }]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "enable", name: "dhcp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "ip/dhcp-server",
        "*1",
        { disabled: "false" },
      );
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "dhcp1", disabled: "false" }]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "disable", name: "dhcp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "ip/dhcp-server",
        "*1",
        { disabled: "true" },
      );
    });

    it("throws NOT_FOUND when server does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageServerTool.handler(
          { routerId: "test-router", action: "enable", name: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "dhcp1", disabled: "false" }]);
      const result = await manageServerTool.handler(
        { routerId: "test-router", action: "disable", name: "dhcp1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

});

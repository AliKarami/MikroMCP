import { describe, it, expect, vi } from "vitest";
import { dhcpClientTools } from "../../../src/domain/tools/dhcp-client-tools.js";
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
      create: vi.fn().mockResolvedValue({ ".id": "*1", interface: "ether1" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = dhcpClientTools;

describe("dhcpClientTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(dhcpClientTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_dhcp_clients");
      expect(manageTool.name).toBe("manage_dhcp_client");
    });
    it("list_dhcp_clients is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_dhcp_client is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("manage_dhcp_client has snapshotPaths", () => expect(manageTool.snapshotPaths).toContain("ip/dhcp-client"));
  });

  describe("list_dhcp_clients handler", () => {
    const clients = [
      { ".id": "*1", interface: "ether1", status: "bound", address: "192.168.1.100/24", disabled: "false" },
      { ".id": "*2", interface: "ether2", status: "searching", disabled: "false" },
    ];

    it("returns all clients", async () => {
      const ctx = makeContext(clients);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.clients as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by interface", async () => {
      const ctx = makeContext(clients);
      const result = await listTool.handler({ routerId: "test-router", interface: "ether1" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.clients as unknown[]).length).toBe(1);
    });

    it("filters by status", async () => {
      const ctx = makeContext(clients);
      const result = await listTool.handler({ routerId: "test-router", status: "bound" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.clients as unknown[]).length).toBe(1);
    });

    it("respects limit and offset", async () => {
      const manyClients = Array.from({ length: 5 }, (_, i) => ({
        ".id": `*${i}`,
        interface: `ether${i}`,
        status: "bound",
      }));
      const ctx = makeContext(manyClients);
      const result = await listTool.handler({ routerId: "test-router", limit: 2, offset: 1 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.clients as unknown[]).length).toBe(2);
      expect(sc.total).toBe(5);
      expect(sc.hasMore).toBe(true);
    });
  });

  describe("manage_dhcp_client - add", () => {
    it("adds client when interface not configured", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "ip/dhcp-client",
        expect.objectContaining({ interface: "ether1" }),
      );
    });

    it("returns already_exists when same interface exists", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("dry_run returns diff without creating", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", interface: "ether1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("manage_dhcp_client - remove", () => {
    it("removes existing client", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/dhcp-client", "*1");
    });

    it("returns not_found when client missing", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", interface: "ether99" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
    });

    it("dry_run returns preview without removing", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", interface: "ether1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("manage_dhcp_client - enable/disable", () => {
    it("disables client", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/dhcp-client", "*1", { disabled: "true" });
    });

    it("enables client", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1", disabled: "true" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/dhcp-client", "*1", { disabled: "false" });
    });

    it("throws NOT_FOUND on enable/disable when client missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "enable", interface: "ether99" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run for disable returns diff without updating", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "ether1", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", interface: "ether1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

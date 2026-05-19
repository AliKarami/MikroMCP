import { describe, it, expect, vi } from "vitest";
import { vrrpTools } from "../../../src/domain/tools/vrrp-tools.js";
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

function makeContext(instances: Record<string, unknown>[] = []): ToolContext {
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
      get: vi.fn().mockResolvedValue(instances),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "test-instance" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listInstancesTool, manageInstanceTool] = vrrpTools;

describe("vrrpTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(vrrpTools).toHaveLength(2));

    it("has correct tool names", () => {
      expect(listInstancesTool.name).toBe("list_vrrp_instances");
      expect(manageInstanceTool.name).toBe("manage_vrrp_instance");
    });

    it("list_vrrp_instances is readOnly", () =>
      expect(listInstancesTool.annotations.readOnlyHint).toBe(true));

    it("manage_vrrp_instance is not readOnly", () =>
      expect(manageInstanceTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema — list_vrrp_instances", () => {
    it("parses valid input", () => {
      const result = listInstancesTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listInstancesTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("allows optional interface filter", () => {
      const result = listInstancesTool.inputSchema.parse({
        routerId: "r1",
        interface: "ether1",
      });
      expect(result.interface).toBe("ether1");
    });

    it("rejects extra fields", () => {
      const result = listInstancesTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listInstancesTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_vrrp_instance", () => {
    it("parses valid add input", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        interface: "ether1",
        vrid: 100,
      });
      expect(result.success).toBe(true);
    });

    it("applies defaults: priority=100, version=3, dryRun=false", () => {
      const result = manageInstanceTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
      });
      expect(result.priority).toBe(100);
      expect(result.version).toBe("3");
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        name: "vrrp1",
      });
      expect(result.success).toBe(false);
    });

    it("rejects VRID out of range (0)", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        vrid: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects VRID out of range (256)", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        vrid: 256,
      });
      expect(result.success).toBe(false);
    });

    it("rejects priority out of range (0)", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        priority: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects priority out of range (255)", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        priority: 255,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid version", () => {
      const result = manageInstanceTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vrrp1",
        version: "1",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_vrrp_instances", () => {
    it("returns instances in structuredContent", async () => {
      const ctx = makeContext([
        {
          ".id": "*1",
          name: "vrrp1",
          interface: "ether1",
          vrid: "100",
          priority: "100",
        },
        {
          ".id": "*2",
          name: "vrrp2",
          interface: "ether2",
          vrid: "101",
          priority: "50",
        },
      ]);
      const result = await listInstancesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.instances as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by interface exact match", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
        { ".id": "*2", name: "vrrp2", interface: "ether2", vrid: "101" },
      ]);
      const result = await listInstancesTool.handler(
        { routerId: "test-router", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.instances as unknown[]).length).toBe(1);
      expect(((sc.instances as unknown[]) as Record<string, unknown>[])[0].name).toBe("vrrp1");
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
        { ".id": "*2", name: "vrrp2", interface: "ether2", vrid: "101" },
        { ".id": "*3", name: "vrrp3", interface: "ether3", vrid: "102" },
      ]);
      const result = await listInstancesTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.instances as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });

    it("throws enriched error on failure", async () => {
      const ctx = makeContext([]);
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error"),
      );
      await expect(listInstancesTool.handler({ routerId: "test-router" }, ctx)).rejects.toThrow();
    });
  });

  describe("handler — manage_vrrp_instance add", () => {
    it("creates instance when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageInstanceTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "vrrp1",
          interface: "ether1",
          vrid: 100,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/vrrp",
        expect.objectContaining({
          name: "vrrp1",
          interface: "ether1",
          vrid: "100",
          priority: "100",
          version: "3",
        }),
      );
    });

    it("returns already_exists when instance found with same interface and vrid", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
      ]);
      const result = await manageInstanceTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "vrrp1",
          interface: "ether1",
          vrid: 100,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when instance found with different interface", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
      ]);
      await expect(
        manageInstanceTool.handler(
          {
            routerId: "test-router",
            action: "add",
            name: "vrrp1",
            interface: "ether2",
            vrid: 100,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws CONFLICT when instance found with different vrid", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
      ]);
      await expect(
        manageInstanceTool.handler(
          {
            routerId: "test-router",
            action: "add",
            name: "vrrp1",
            interface: "ether1",
            vrid: 101,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION error when interface is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageInstanceTool.handler(
          { routerId: "test-router", action: "add", name: "vrrp1", vrid: 100 },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "VRRP_INTERFACE_REQUIRED" });
    });

    it("throws VALIDATION error when vrid is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageInstanceTool.handler(
          { routerId: "test-router", action: "add", name: "vrrp1", interface: "ether1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "VRRP_VRID_REQUIRED" });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageInstanceTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "vrrp1",
          interface: "ether1",
          vrid: 100,
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("includes optional fields in create request", async () => {
      const ctx = makeContext([]);
      await manageInstanceTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "vrrp1",
          interface: "ether1",
          vrid: 100,
          interval: 5,
          comment: "test vrrp",
        },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/vrrp",
        expect.objectContaining({
          interval: "5",
          comment: "test vrrp",
        }),
      );
    });
  });

  describe("handler — manage_vrrp_instance remove", () => {
    it("removes instance when found", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
      ]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "remove", name: "vrrp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/vrrp", "*1");
    });

    it("returns not_found when instance already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "remove", name: "vrrp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vrrp1", interface: "ether1", vrid: "100" },
      ]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "remove", name: "vrrp1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_vrrp_instance enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vrrp1", disabled: "true" }]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "enable", name: "vrrp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/vrrp", "*1", {
        disabled: "false",
      });
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vrrp1", disabled: "false" }]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "disable", name: "vrrp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/vrrp", "*1", {
        disabled: "true",
      });
    });

    it("throws NOT_FOUND when instance does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageInstanceTool.handler(
          { routerId: "test-router", action: "enable", name: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vrrp1", disabled: "false" }]);
      const result = await manageInstanceTool.handler(
        { routerId: "test-router", action: "disable", name: "vrrp1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

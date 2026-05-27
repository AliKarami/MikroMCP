import { describe, it, expect, vi } from "vitest";
import { wireguardTools } from "../../../src/domain/tools/wireguard-tools.js";
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

function makeContext(records: Record<string, unknown>[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: { upload: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listWgTool, listPeersTool, managePeerTool] = wireguardTools;

describe("manage_wireguard_interface", () => {
  const manageWgIfaceTool = wireguardTools.find((t) => t.name === "manage_wireguard_interface")!;

  const WG_IFACE = { ".id": "*1", name: "wg0", "listen-port": "51820", mtu: "1420", "public-key": "AAAA==", disabled: "false", running: "true" };

  function makeWgIfaceContext(ifaces: Record<string, unknown>[] = []) {
    return {
      routerId: "test-router",
      correlationId: "test-corr",
      routerConfig: {} as RouterConfig,
      sshClient: {} as SshClient,
      ftpClient: {} as FtpClient,
      identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
      routerClient: {
        get: vi.fn().mockResolvedValue(ifaces),
        create: vi.fn().mockResolvedValue({ ".id": "*2", name: "wg1", "public-key": "BBBB==" }),
        update: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as RouterOSRestClient,
    } as unknown as ToolContext;
  }

  describe("metadata", () => {
    it("exists in wireguardTools", () => expect(manageWgIfaceTool).toBeDefined());
    it("is not readOnly", () => expect(manageWgIfaceTool.annotations.readOnlyHint).toBe(false));
    it("is not destructive", () => expect(manageWgIfaceTool.annotations.destructiveHint).toBe(false));
  });

  describe("input schema", () => {
    it("parses valid add", () => {
      expect(manageWgIfaceTool.inputSchema.safeParse({ routerId: "r1", action: "add", name: "wg1" }).success).toBe(true);
    });
    it("mtu defaults 1420", () => {
      expect(manageWgIfaceTool.inputSchema.parse({ routerId: "r1", action: "add", name: "wg1" }).mtu).toBe(1420);
    });
    it("rejects extra fields", () => {
      expect(manageWgIfaceTool.inputSchema.safeParse({ routerId: "r1", action: "add", name: "wg1", extra: true }).success).toBe(false);
    });
  });

  describe("handler — add", () => {
    it("creates interface when not found", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "add", name: "wg1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect((result.structuredContent as Record<string, unknown>).publicKey).toBe("BBBB==");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/wireguard", expect.objectContaining({ name: "wg1" }));
    });

    it("returns already_exists when found", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "add", name: "wg0" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "add", name: "wg1", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — remove", () => {
    it("removes interface when found", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "remove", name: "wg0" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/wireguard", "*1");
    });

    it("returns not_found gracefully when missing", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "remove", name: "wg1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });
  });

  describe("handler — enable/disable", () => {
    it("disables an interface", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "disable", name: "wg0" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/wireguard", "*1", { disabled: "true" });
    });

    it("enables an interface", async () => {
      const disabledIface = { ...WG_IFACE, disabled: "true" };
      const ctx = makeWgIfaceContext([disabledIface]);
      const result = await manageWgIfaceTool.handler({ routerId: "test-router", action: "enable", name: "wg0" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/wireguard", "*1", { disabled: "false" });
    });
  });
});

describe("wireguardTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => expect(wireguardTools).toHaveLength(4));
    it("list_wireguard_interfaces is readOnly", () =>
      expect(listWgTool.annotations.readOnlyHint).toBe(true));
    it("manage_wireguard_peer is not readOnly", () =>
      expect(managePeerTool.annotations.readOnlyHint).toBe(false));
  });

  describe("list_wireguard_interfaces", () => {
    it("returns interfaces in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "wg0", "listen-port": "51820", running: "true" },
      ]);
      const result = await listWgTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.interfaces as unknown[]).length).toBe(1);
    });
  });

  describe("manage_wireguard_peer", () => {
    const testPublicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    it("returns already_exists when peer with same public key exists", async () => {
      const ctx = makeContext([{ ".id": "*1", interface: "wg0", "public-key": testPublicKey }]);
      const result = await managePeerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          interface: "wg0",
          publicKey: testPublicKey,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("throws NOT_FOUND when removing non-existent peer", async () => {
      const ctx = makeContext([]);
      await expect(
        managePeerTool.handler(
          {
            routerId: "test-router",
            action: "remove",
            interface: "wg0",
            publicKey: testPublicKey,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry-run add returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const result = await managePeerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          interface: "wg0",
          publicKey: testPublicKey,
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });
});

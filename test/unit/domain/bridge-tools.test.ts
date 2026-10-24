import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { bridgeTools } from "../../../src/domain/tools/bridge-tools.js";
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

function makeContext(
  bridgeRecords: Record<string, unknown>[],
  portRecords: Record<string, unknown>[] = [],
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "corr",
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
      get: vi.fn().mockResolvedValueOnce(bridgeRecords).mockResolvedValueOnce(portRecords),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listBridgesTool, manageBridgeTool, manageBridgePortTool] = bridgeTools;

describe("bridgeTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => {
      expect(bridgeTools).toHaveLength(4);
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
      const result = await manageBridgeTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "bridge2",
          dryRun: true,
        },
        ctx,
      );
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
      const result = await manageBridgeTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "bridge1",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("create accepts a 19-char name the old 15-char schema limit rejected", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ ".id": "*2" }),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        { routerId: "test-router", action: "create", name: "bonding-core-switch" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
    });

    it("create rejects a name longer than 64 chars", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: { get: vi.fn().mockResolvedValue([]) } as unknown as RouterOSRestClient,
      };
      await expect(
        manageBridgeTool.handler(
          { routerId: "test-router", action: "create", name: "b".repeat(65) },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BRIDGE_NAME_INVALID" });
    });

    it("remove accepts a 26-char existing name the old 15-char schema limit rejected", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([{ ".id": "*3", name: "wireguard-back-to-home-vpn" }]),
          remove,
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        { routerId: "test-router", action: "remove", name: "wireguard-back-to-home-vpn" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(remove).toHaveBeenCalledWith("interface/bridge", "*3");
    });
  });

  describe("manage_bridge_port", () => {
    it("rejects extra fields", () => {
      const schema = z
        .object({
          routerId: z.string(),
          action: z.enum(["add", "remove"]),
          bridge: z.string(),
          interface: z.string(),
          dryRun: z.boolean().default(false),
        })
        .strict();
      expect(() =>
        schema.parse({ routerId: "r", action: "add", bridge: "b", interface: "e", extra: 1 }),
      ).toThrow();
    });
  });
});

describe("list_bridge_ports", () => {
  const listBridgePortsTool = bridgeTools.find((t) => t.name === "list_bridge_ports")!;
  const ports = [
    {
      ".id": "*0",
      bridge: "bridge1",
      interface: "ether1",
      pvid: 1,
      status: "in-bridge",
      "debug-info": " prio 0x80 num 1\n role:Designated",
    },
    { ".id": "*7", bridge: "bridge1", interface: "wifi1", pvid: 1, status: "in-bridge" },
  ];

  it("is a read-only tool", () => {
    expect(listBridgePortsTool.annotations.readOnlyHint).toBe(true);
  });

  it("returns ports without the debug-info STP dump", async () => {
    const ctx = makeContext(ports);
    const result = await listBridgePortsTool.handler({ routerId: "test-router" }, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    const rows = sc.ports as Array<Record<string, unknown>>;
    expect(sc.total).toBe(2);
    expect(rows[0]).not.toHaveProperty("debug-info");
    expect(rows[0].interface).toBe("ether1");
    expect(result.content).toContain("interface=wifi1");
  });

  it("passes bridge and interface filters to the router query", async () => {
    const ctx = makeContext([ports[0]]);
    await listBridgePortsTool.handler(
      { routerId: "test-router", bridge: "bridge1", interface: "ether1" },
      ctx,
    );
    expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/port", {
      filter: { bridge: "bridge1", interface: "ether1" },
    });
  });

  it("queries without a filter when none is given", async () => {
    const ctx = makeContext(ports);
    await listBridgePortsTool.handler({ routerId: "test-router" }, ctx);
    expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/port", {});
  });
});

import { describe, it, expect, vi } from "vitest";
import { wireguardTools } from "../../../src/domain/tools/wireguard-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { fromWire } from "../helpers/wire.js";

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
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listWgTool, listPeersTool, managePeerTool] = wireguardTools;

describe("manage_wireguard_interface", () => {
  const manageWgIfaceTool = wireguardTools.find((t) => t.name === "manage_wireguard_interface")!;

  const WG_IFACE = {
    ".id": "*1",
    name: "wg0",
    "listen-port": "51820",
    mtu: "1420",
    "public-key": "AAAA==",
    disabled: "false",
    running: "true",
  };

  function makeWgIfaceContext(ifaces: Record<string, unknown>[] = []) {
    return {
      routerId: "test-router",
      correlationId: "test-corr",
      routerConfig: {} as RouterConfig,
      sshClient: {} as SshClient,
      ftpClient: {} as FtpClient,
      identity: {
        id: "superadmin-builtin",
        role: "superadmin" as const,
        allowedRouters: [],
        allowedToolPatterns: [],
      },
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
    it("is destructive (can sever VPN connectivity)", () =>
      expect(manageWgIfaceTool.annotations.destructiveHint).toBe(true));
  });

  describe("input schema", () => {
    it("parses valid add", () => {
      expect(
        manageWgIfaceTool.inputSchema.safeParse({ routerId: "r1", action: "add", name: "wg1" })
          .success,
      ).toBe(true);
    });
    it("mtu defaults 1420", () => {
      expect(
        manageWgIfaceTool.inputSchema.parse({ routerId: "r1", action: "add", name: "wg1" }).mtu,
      ).toBe(1420);
    });
    it("rejects extra fields", () => {
      expect(
        manageWgIfaceTool.inputSchema.safeParse({
          routerId: "r1",
          action: "add",
          name: "wg1",
          extra: true,
        }).success,
      ).toBe(false);
    });
  });

  describe("handler — add", () => {
    it("creates interface when not found", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "add", name: "wg1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect((result.structuredContent as Record<string, unknown>).publicKey).toBe("BBBB==");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/wireguard",
        expect.objectContaining({ name: "wg1" }),
      );
    });

    it("returns already_exists when found", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "add", name: "wg0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "add", name: "wg1", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — remove", () => {
    it("removes interface when found", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "remove", name: "wg0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/wireguard", "*1");
    });

    it("returns not_found gracefully when missing", async () => {
      const ctx = makeWgIfaceContext([]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "remove", name: "wg1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });
  });

  describe("handler — enable/disable", () => {
    it("disables an interface", async () => {
      const ctx = makeWgIfaceContext([WG_IFACE]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "disable", name: "wg0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/wireguard", "*1", {
        disabled: "true",
      });
    });

    it("enables an interface", async () => {
      const disabledIface = { ...WG_IFACE, disabled: "true" };
      const ctx = makeWgIfaceContext([disabledIface]);
      const result = await manageWgIfaceTool.handler(
        { routerId: "test-router", action: "enable", name: "wg0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/wireguard", "*1", {
        disabled: "false",
      });
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
    const addParams = {
      routerId: "test-router",
      action: "add",
      interface: "wg0",
      publicKey: testPublicKey,
    };
    const endpoints = [
      { endpoint: "192.0.2.1:51820", address: "192.0.2.1", port: "51820" },
      { endpoint: "vpn.example.com:51821", address: "vpn.example.com", port: "51821" },
      { endpoint: "[2001:db8::1]:51820", address: "2001:db8::1", port: "51820" },
      { endpoint: "[::ffff:192.0.2.1]:51820", address: "::ffff:192.0.2.1", port: "51820" },
      { endpoint: "192.0.2.1:1", address: "192.0.2.1", port: "1" },
      { endpoint: "vpn.example.com:65535", address: "vpn.example.com", port: "65535" },
      { endpoint: "192.0.2.1", address: "192.0.2.1", port: undefined },
      { endpoint: "vpn.example.com", address: "vpn.example.com", port: undefined },
    ];
    const invalidEndpoints = [
      "",
      ":51820",
      "192.0.2.1:",
      "vpn.example.com:",
      "192.0.2.1:0",
      "192.0.2.1:65536",
      "192.0.2.1:-1",
      "192.0.2.1:1.5",
      "192.0.2.1:1e3",
      "192.0.2.1:port",
      "192.0.2.1:51820:42",
      "2001:db8::1:51820",
      "2001:db8::1",
      "[2001:db8::1]",
      "[2001:db8::1]:",
      "[2001:db8::1]:0",
      "[2001:db8::1]:65536",
      "[not-an-ip]:51820",
      "[192.0.2.1]:51820",
      "[fe80::1%eth0]:51820",
      "[2001:db8::1:51820",
      "https://vpn.example.com:51820",
      "vpn.example.com:51820/path",
      "vpn.example.com/path",
      "user@vpn.example.com:51820",
      "vpn.example.com:51820?query",
      " vpn.example.com:51820",
      "vpn.example.com:51820 ",
      "vpn.example.com\n:51820",
      "999.1.1.1:51820",
      "vpn..example.com:51820",
      "-vpn.example.com:51820",
      "vpn_.example.com:51820",
      `${"a".repeat(64)}.example.com:51820`,
      `${Array(5).fill("a".repeat(63)).join(".")}:51820`,
    ];

    describe("input schema", () => {
      it.each(endpoints)("accepts $endpoint", ({ endpoint }) => {
        expect(managePeerTool.inputSchema.safeParse({ ...addParams, endpoint }).success).toBe(true);
      });

      it.each(invalidEndpoints)("rejects malformed endpoint %j", (endpoint) => {
        expect(managePeerTool.inputSchema.safeParse({ ...addParams, endpoint }).success).toBe(
          false,
        );
      });

      it.each(["add", "remove"])("allows %s without an endpoint", (action) => {
        expect(managePeerTool.inputSchema.safeParse({ ...addParams, action }).success).toBe(true);
      });
    });

    it.each(endpoints)(
      "creates peer with the RouterOS fields for $endpoint",
      async ({ endpoint, address, port }) => {
        const ctx = makeContext([]);
        const result = await managePeerTool.handler({ ...addParams, endpoint }, ctx);
        expect(result.structuredContent?.action).toBe("created");
        expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/wireguard/peers", {
          interface: "wg0",
          "public-key": testPublicKey,
          "endpoint-address": address,
          ...(port === undefined ? {} : { "endpoint-port": port }),
        });
      },
    );

    it.each(endpoints)(
      "previews the same RouterOS fields for $endpoint without creating",
      async ({ endpoint, address, port }) => {
        const ctx = makeContext([]);
        const result = await managePeerTool.handler({ ...addParams, endpoint, dryRun: true }, ctx);
        expect(result.structuredContent).toEqual({
          action: "dry_run",
          diff: [
            { property: "interface", before: null, after: "wg0" },
            { property: "public-key", before: null, after: testPublicKey },
            { property: "endpoint-address", before: null, after: address },
            ...(port === undefined
              ? []
              : [{ property: "endpoint-port", before: null, after: port }]),
          ],
        });
        expect(ctx.routerClient.create).not.toHaveBeenCalled();
      },
    );

    it.each(invalidEndpoints)("rejects %j before any router request", async (endpoint) => {
      const ctx = makeContext([]);
      await expect(managePeerTool.handler({ ...addParams, endpoint }, ctx)).rejects.toThrow();
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("omits endpoint fields when no endpoint is supplied", async () => {
      const ctx = makeContext([]);
      await managePeerTool.handler(addParams, ctx);
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/wireguard/peers", {
        interface: "wg0",
        "public-key": testPublicKey,
      });
    });

    it("removes an existing peer without requiring an endpoint", async () => {
      const ctx = makeContext(
        fromWire([{ ".id": "*1", interface: "wg0", "public-key": testPublicKey }]),
      );
      const result = await managePeerTool.handler({ ...addParams, action: "remove" }, ctx);
      expect(result.structuredContent?.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/wireguard/peers", "*1");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("previews removal without requiring an endpoint or removing the peer", async () => {
      const ctx = makeContext(
        fromWire([{ ".id": "*1", interface: "wg0", "public-key": testPublicKey }]),
      );
      const result = await managePeerTool.handler(
        { ...addParams, action: "remove", dryRun: true },
        ctx,
      );
      expect(result.structuredContent?.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

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

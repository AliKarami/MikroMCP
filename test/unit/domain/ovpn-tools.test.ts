import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ovpnTools } from "../../../src/domain/tools/ovpn-tools.js";
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
  records: Record<string, unknown>[] = [],
  overrides: Partial<RouterOSRestClient> = {},
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "ovpn-client1" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as RouterOSRestClient,
  };
}

const [listClientsTool, manageClientTool, getServerTool, manageServerTool] = ovpnTools;

const sampleServer = {
  ".id": "*0",
  enabled: "yes",
  port: "1194",
  mode: "ip",
  protocol: "tcp-server",
  certificate: "server-cert",
  cipher: "aes256-cbc",
  auth: "sha1",
};

describe("ovpnTools", () => {
  describe("metadata", () => {
    it("exports exactly 4 tools", () => expect(ovpnTools).toHaveLength(4));
    it("has correct names", () => {
      expect(ovpnTools.map((t) => t.name)).toEqual([
        "list_ovpn_clients",
        "manage_ovpn_client",
        "get_ovpn_server",
        "manage_ovpn_server",
      ]);
    });
    it("list_ovpn_clients is readOnly", () => expect(listClientsTool.annotations.readOnlyHint).toBe(true));
    it("get_ovpn_server is readOnly", () => expect(getServerTool.annotations.readOnlyHint).toBe(true));
    it("manage_ovpn_client is not readOnly and is destructive", () => {
      expect(manageClientTool.annotations.readOnlyHint).toBe(false);
      expect(manageClientTool.annotations.destructiveHint).toBe(true);
    });
    it("manage_ovpn_server is not readOnly and is destructive", () => {
      expect(manageServerTool.annotations.readOnlyHint).toBe(false);
      expect(manageServerTool.annotations.destructiveHint).toBe(true);
    });
    it("manage_ovpn_client has snapshotPaths", () =>
      expect(manageClientTool.snapshotPaths).toContain("interface/ovpn-client"));
    it("manage_ovpn_server has snapshotPaths", () =>
      expect(manageServerTool.snapshotPaths).toContain("interface/ovpn-server/server"));
  });

  describe("list_ovpn_clients input schema", () => {
    const schema = z
      .object({
        routerId: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      })
      .strict();

    it("applies defaults", () => {
      const r = schema.parse({ routerId: "r1" });
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });
    it("rejects extra fields", () => {
      expect(() => schema.parse({ routerId: "r1", bogus: true })).toThrow();
    });
  });

  describe("handler - list_ovpn_clients", () => {
    const clients = [
      { ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1", running: true },
      { ".id": "*2", name: "ovpn-branch", "connect-to": "10.0.0.2", running: false },
    ];

    it("returns all clients", async () => {
      const ctx = makeContext(clients);
      const r = await listClientsTool.handler({ routerId: "test-router", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(2);
      expect(r.structuredContent.clients).toHaveLength(2);
      expect(r.structuredContent.hasMore).toBe(false);
    });

    it("paginates and sets hasMore", async () => {
      const ctx = makeContext(clients);
      const r = await listClientsTool.handler({ routerId: "test-router", limit: 1, offset: 0 }, ctx);
      expect(r.structuredContent.clients).toHaveLength(1);
      expect(r.structuredContent.hasMore).toBe(true);
    });

    it("returns empty list when no clients configured", async () => {
      const ctx = makeContext([]);
      const r = await listClientsTool.handler({ routerId: "test-router", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(0);
    });
  });

  describe("handler - manage_ovpn_client add", () => {
    it("creates a new client with required fields", async () => {
      const ctx = makeContext([]);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "add", name: "ovpn-hq", connectTo: "10.0.0.1", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/ovpn-client",
        expect.objectContaining({ name: "ovpn-hq", "connect-to": "10.0.0.1" }),
      );
    });

    it("includes optional fields in create body", async () => {
      const ctx = makeContext([]);
      await manageClientTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "ovpn-hq",
          connectTo: "10.0.0.1",
          port: 1194,
          mode: "ip",
          protocol: "tcp-client",
          certificate: "client-cert",
          user: "vpnuser",
          password: "vpnpass",
          dryRun: false,
        },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/ovpn-client",
        expect.objectContaining({
          port: "1194",
          mode: "ip",
          protocol: "tcp-client",
          certificate: "client-cert",
          user: "vpnuser",
          password: "vpnpass",
        }),
      );
    });

    it("returns already_exists for same name and connectTo", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "add", name: "ovpn-hq", connectTo: "10.0.0.1", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT for same name but different connectTo", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1" }];
      const ctx = makeContext(existing);
      await expect(
        manageClientTool.handler(
          { routerId: "test-router", action: "add", name: "ovpn-hq", connectTo: "10.0.0.2", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT, code: "OVPN_CLIENT_CONFLICT" });
    });

    it("throws VALIDATION when connectTo is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageClientTool.handler(
          { routerId: "test-router", action: "add", name: "ovpn-hq", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "OVPN_CLIENT_CONNECT_TO_REQUIRED" });
    });

    it("returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "add", name: "ovpn-hq", connectTo: "10.0.0.1", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_ovpn_client update", () => {
    it("updates fields that differ", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1", port: "1194" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "update", name: "ovpn-hq", port: 1195, dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/ovpn-client", "*1", { port: "1195" });
    });

    it("returns no_change when all specified fields already match", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1", port: "1194" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "update", name: "ovpn-hq", connectTo: "10.0.0.1", port: 1194, dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("always writes password when provided", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "update", name: "ovpn-hq", password: "newpass", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/ovpn-client", "*1", { password: "newpass" });
    });

    it("throws NOT_FOUND when client does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageClientTool.handler(
          { routerId: "test-router", action: "update", name: "ovpn-hq", port: 1195, dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "OVPN_CLIENT_NOT_FOUND" });
    });

    it("returns dry_run without calling update", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1", port: "1194" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "update", name: "ovpn-hq", port: 1195, dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_ovpn_client remove", () => {
    it("removes an existing client", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "remove", name: "ovpn-hq", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/ovpn-client", "*1");
    });

    it("returns not_found gracefully", async () => {
      const ctx = makeContext([]);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "remove", name: "ovpn-hq", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("returns dry_run without calling remove", async () => {
      const existing = [{ ".id": "*1", name: "ovpn-hq", "connect-to": "10.0.0.1" }];
      const ctx = makeContext(existing);
      const r = await manageClientTool.handler(
        { routerId: "test-router", action: "remove", name: "ovpn-hq", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler - get_ovpn_server", () => {
    it("returns server configuration", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await getServerTool.handler({ routerId: "test-router" }, ctx);
      expect(r.structuredContent.server).toMatchObject({ enabled: "yes", port: "1194" });
    });

    it("throws NOT_FOUND when OpenVPN package is not installed", async () => {
      const ctx = makeContext([]);
      await expect(getServerTool.handler({ routerId: "test-router" }, ctx)).rejects.toMatchObject({
        code: "OVPN_SERVER_NOT_FOUND",
      });
    });
  });

  describe("handler - manage_ovpn_server enable/disable", () => {
    it("enables the server", async () => {
      const ctx = makeContext([{ ...sampleServer, enabled: "no" }]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "enable", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "interface/ovpn-server/server",
        "*0",
        { enabled: "yes" },
      );
    });

    it("returns no_change when already enabled", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "enable", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("disables the server", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "disable", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "interface/ovpn-server/server",
        "*0",
        { enabled: "no" },
      );
    });

    it("returns no_change when already disabled", async () => {
      const ctx = makeContext([{ ...sampleServer, enabled: "no" }]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "disable", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("returns dry_run for enable without calling update", async () => {
      const ctx = makeContext([{ ...sampleServer, enabled: "no" }]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "enable", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_ovpn_server set", () => {
    it("updates provided config fields", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "set", port: 1195, dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "interface/ovpn-server/server",
        "*0",
        { port: "1195" },
      );
    });

    it("returns no_change when all specified fields already match", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "set", port: 1194, cipher: "aes256-cbc", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws VALIDATION when no fields provided for set", async () => {
      const ctx = makeContext([sampleServer]);
      await expect(
        manageServerTool.handler({ routerId: "test-router", action: "set", dryRun: false }, ctx),
      ).rejects.toMatchObject({ code: "OVPN_SERVER_NO_FIELDS" });
    });

    it("returns dry_run with diff without calling update", async () => {
      const ctx = makeContext([sampleServer]);
      const r = await manageServerTool.handler(
        { routerId: "test-router", action: "set", port: 1195, dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when OpenVPN package is not installed", async () => {
      const ctx = makeContext([]);
      await expect(
        manageServerTool.handler({ routerId: "test-router", action: "set", port: 1195, dryRun: false }, ctx),
      ).rejects.toMatchObject({ code: "OVPN_SERVER_NOT_FOUND" });
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { pppoeTools } from "../../../src/domain/tools/pppoe-tools.js";
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
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "pppoe-wan" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

const [listTool, manageTool] = pppoeTools;

describe("pppoeTools", () => {
  describe("metadata", () => {
    it("exports exactly 2 tools", () => expect(pppoeTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_pppoe_clients");
      expect(manageTool.name).toBe("manage_pppoe_client");
    });
    it("list_pppoe_clients is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_pppoe_client is not readOnly and is destructive", () => {
      expect(manageTool.annotations.readOnlyHint).toBe(false);
      expect(manageTool.annotations.destructiveHint).toBe(true);
    });
    it("manage_pppoe_client has snapshotPaths", () =>
      expect(manageTool.snapshotPaths).toContain("interface/pppoe-client"));
  });

  describe("list_pppoe_clients input schema", () => {
    const schema = z
      .object({
        routerId: z.string(),
        interface: z.string().optional(),
        status: z.enum(["connected", "disconnected", "all"]).default("all"),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      })
      .strict();

    it("applies defaults", () => {
      const r = schema.parse({ routerId: "r1" });
      expect(r.status).toBe("all");
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });
    it("rejects extra fields", () => {
      expect(() => schema.parse({ routerId: "r1", bogus: true })).toThrow();
    });
    it("rejects invalid status", () => {
      expect(() => schema.parse({ routerId: "r1", status: "unknown" })).toThrow();
    });
    it("rejects limit above 500", () => {
      expect(() => schema.parse({ routerId: "r1", limit: 501 })).toThrow();
    });
  });

  describe("handler - list_pppoe_clients", () => {
    const clients = [
      { ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "isp-user", running: true },
      { ".id": "*2", name: "pppoe-backup", interface: "ether2", user: "isp-user-2", running: false },
      { ".id": "*3", name: "pppoe-lte", interface: "ether3", user: "lte-user", running: "true" },
    ];

    it("returns all clients with no filter", async () => {
      const ctx = makeContext(clients);
      const r = await listTool.handler({ routerId: "test-router", status: "all", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(3);
      expect(r.structuredContent.clients).toHaveLength(3);
      expect(r.structuredContent.hasMore).toBe(false);
    });

    it("filters to connected clients only", async () => {
      const ctx = makeContext(clients);
      const r = await listTool.handler({ routerId: "test-router", status: "connected", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(2); // running: true and running: "true"
    });

    it("filters to disconnected clients only", async () => {
      const ctx = makeContext(clients);
      const r = await listTool.handler({ routerId: "test-router", status: "disconnected", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(1);
      expect((r.structuredContent.clients as Record<string, unknown>[])[0].name).toBe("pppoe-backup");
    });

    it("filters by parent interface", async () => {
      const ctx = makeContext(clients);
      const r = await listTool.handler(
        { routerId: "test-router", interface: "ether1", status: "all", limit: 100, offset: 0 },
        ctx,
      );
      expect(r.structuredContent.total).toBe(1);
    });

    it("paginates correctly and sets hasMore", async () => {
      const ctx = makeContext(clients);
      const r = await listTool.handler({ routerId: "test-router", status: "all", limit: 2, offset: 0 }, ctx);
      expect(r.structuredContent.clients).toHaveLength(2);
      expect(r.structuredContent.hasMore).toBe(true);
      expect(r.structuredContent.total).toBe(3);
    });

    it("returns empty list when no clients exist", async () => {
      const ctx = makeContext([]);
      const r = await listTool.handler({ routerId: "test-router", status: "all", limit: 100, offset: 0 }, ctx);
      expect(r.structuredContent.total).toBe(0);
      expect(r.structuredContent.clients).toHaveLength(0);
    });
  });

  describe("handler - manage_pppoe_client add", () => {
    it("creates a new client with required fields", async () => {
      const ctx = makeContext([]);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pppoe-wan", interface: "ether1", user: "myuser", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/pppoe-client",
        expect.objectContaining({ name: "pppoe-wan", interface: "ether1", user: "myuser" }),
      );
    });

    it("includes optional fields in create body when provided", async () => {
      const ctx = makeContext([]);
      await manageTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "pppoe-wan",
          interface: "ether1",
          user: "myuser",
          password: "secret",
          serviceName: "isp-svc",
          addDefaultRoute: true,
          dialOnDemand: false,
          dryRun: false,
        },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "interface/pppoe-client",
        expect.objectContaining({
          password: "secret",
          "service-name": "isp-svc",
          "add-default-route": "yes",
          "dial-on-demand": "no",
        }),
      );
    });

    it("returns already_exists when same name+interface+user exists", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "myuser" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pppoe-wan", interface: "ether1", user: "myuser", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when same name exists with different user", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "old-user" }];
      const ctx = makeContext(existing);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "pppoe-wan", interface: "ether1", user: "new-user", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT, code: "PPPOE_CLIENT_CONFLICT" });
    });

    it("throws VALIDATION when interface is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "pppoe-wan", user: "myuser", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "PPPOE_CLIENT_INTERFACE_REQUIRED" });
    });

    it("throws VALIDATION when user is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "pppoe-wan", interface: "ether1", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "PPPOE_CLIENT_USER_REQUIRED" });
    });

    it("returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "pppoe-wan", interface: "ether1", user: "myuser", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(Array.isArray(r.structuredContent.diff)).toBe(true);
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_pppoe_client update", () => {
    it("updates fields that differ", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "old-user", "service-name": "" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "pppoe-wan", user: "new-user", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/pppoe-client", "*1", { user: "new-user" });
      expect(r.structuredContent.diff).toHaveLength(1);
    });

    it("returns no_change when all specified fields already match", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "myuser" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "pppoe-wan", interface: "ether1", user: "myuser", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("always writes password when provided (RouterOS does not expose it in GET)", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "myuser" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "pppoe-wan", password: "newpass", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/pppoe-client", "*1", { password: "newpass" });
    });

    it("throws NOT_FOUND when client does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "update", name: "pppoe-wan", user: "x", dryRun: false },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "PPPOE_CLIENT_NOT_FOUND" });
    });

    it("returns dry_run with diff without calling update", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "old" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "pppoe-wan", user: "new", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_pppoe_client remove", () => {
    it("removes an existing client", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "myuser" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "pppoe-wan", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/pppoe-client", "*1");
    });

    it("returns not_found gracefully when client does not exist", async () => {
      const ctx = makeContext([]);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "pppoe-wan", dryRun: false },
        ctx,
      );
      expect(r.structuredContent.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("returns dry_run without calling remove", async () => {
      const existing = [{ ".id": "*1", name: "pppoe-wan", interface: "ether1", user: "myuser" }];
      const ctx = makeContext(existing);
      const r = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "pppoe-wan", dryRun: true },
        ctx,
      );
      expect(r.structuredContent.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });
});

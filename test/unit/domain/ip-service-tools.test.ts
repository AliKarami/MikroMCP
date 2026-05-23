import { describe, it, expect, vi } from "vitest";
import { ipServiceTools } from "../../../src/domain/tools/ip-service-tools.js";
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

const sampleServices = [
  { ".id": "*1", name: "api", port: "8728", disabled: "false" },
  { ".id": "*2", name: "api-ssl", port: "8729", disabled: "false" },
  { ".id": "*3", name: "ssh", port: "22", disabled: "false" },
  { ".id": "*4", name: "telnet", port: "23", disabled: "true" },
  { ".id": "*5", name: "www", port: "80", disabled: "false" },
  { ".id": "*6", name: "www-ssl", port: "443", disabled: "false" },
  { ".id": "*7", name: "winbox", port: "8291", disabled: "false" },
];

function makeContext(records: Record<string, unknown>[] = sampleServices): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: { upload: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = ipServiceTools;

describe("ipServiceTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(ipServiceTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_ip_services");
      expect(manageTool.name).toBe("manage_ip_service");
    });
    it("list_ip_services is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_ip_service is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema validation", () => {
    it("rejects extra fields on list schema", () => {
      const ctx = makeContext();
      return expect(
        listTool.handler({ routerId: "test-router", unknownField: true }, ctx),
      ).rejects.toThrow();
    });

    it("rejects extra fields on manage schema", () => {
      const ctx = makeContext();
      return expect(
        manageTool.handler({ routerId: "test-router", action: "enable", name: "ssh", unknownField: true }, ctx),
      ).rejects.toThrow();
    });

    it("rejects invalid service name", () => {
      const ctx = makeContext();
      return expect(
        manageTool.handler({ routerId: "test-router", action: "enable", name: "not-a-service" }, ctx),
      ).rejects.toThrow();
    });

    it("rejects invalid action on manage", () => {
      const ctx = makeContext();
      return expect(
        manageTool.handler({ routerId: "test-router", action: "add", name: "ssh" }, ctx),
      ).rejects.toThrow();
    });
  });

  describe("list_ip_services handler", () => {
    it("returns all services", async () => {
      const ctx = makeContext();
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.services as unknown[]).length).toBe(7);
      expect(sc.total).toBe(7);
    });

    it("filters by name", async () => {
      const ctx = makeContext();
      const result = await listTool.handler({ routerId: "test-router", name: "ssh" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.services as unknown[]).length).toBe(1);
    });

    it("filters enabled-only (enabled: true)", async () => {
      const ctx = makeContext();
      const result = await listTool.handler({ routerId: "test-router", enabled: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      // 6 enabled (telnet is disabled)
      expect((sc.services as unknown[]).length).toBe(6);
    });

    it("filters disabled-only (enabled: false)", async () => {
      const ctx = makeContext();
      const result = await listTool.handler({ routerId: "test-router", enabled: false }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.services as unknown[]).length).toBe(1);
    });
  });

  describe("manage_ip_service handler", () => {
    it("disables a service", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "ssh" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/service", "*3", { disabled: "true" });
    });

    it("enables a service", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", name: "telnet" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/service", "*4", { disabled: "false" });
    });

    it("dry_run returns diff without updating", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", name: "telnet", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for unknown service name", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "enable", name: "ssh" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("returns no_change when service is already in desired state (disable)", async () => {
      // telnet is already disabled in sampleServices
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "telnet" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("returns no_change when service is already in desired state (enable)", async () => {
      // ssh is already enabled in sampleServices
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", name: "ssh" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

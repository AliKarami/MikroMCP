import { describe, it, expect, vi } from "vitest";
import { dnsTools } from "../../../src/domain/tools/dns-tools.js";
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

function makeGetContext(records: Record<string, unknown>[]): ToolContext {
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

const [listDnsTool, manageDnsTool, getDnsSettingsTool] = dnsTools;

describe("dnsTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => expect(dnsTools).toHaveLength(4));
    it("list_dns_entries is readOnly", () =>
      expect(listDnsTool.annotations.readOnlyHint).toBe(true));
    it("get_dns_settings is readOnly", () =>
      expect(getDnsSettingsTool.annotations.readOnlyHint).toBe(true));
    it("manage_dns_entry is not readOnly", () =>
      expect(manageDnsTool.annotations.readOnlyHint).toBe(false));
  });

  describe("list_dns_entries", () => {
    it("returns entries in structuredContent", async () => {
      const ctx = makeGetContext([
        { ".id": "*1", name: "host.lan", type: "A", address: "10.0.0.5" },
      ]);
      const result = await listDnsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("filters by type", async () => {
      const ctx = makeGetContext([
        { ".id": "*1", name: "host.lan", type: "A", address: "10.0.0.5" },
        { ".id": "*2", name: "alias.lan", type: "CNAME", cname: "host.lan" },
      ]);
      const result = await listDnsTool.handler({ routerId: "test-router", type: "A" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });
  });

  describe("manage_dns_entry", () => {
    it("returns already_exists when same name+type exists", async () => {
      const ctx = makeGetContext([
        { ".id": "*1", name: "host.lan", type: "A", address: "10.0.0.5" },
      ]);
      const result = await manageDnsTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "host.lan",
          type: "A",
          address: "10.0.0.5",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("throws NOT_FOUND when removing non-existent entry", async () => {
      const ctx = makeGetContext([]);
      await expect(
        manageDnsTool.handler(
          {
            routerId: "test-router",
            action: "remove",
            name: "missing.lan",
            type: "A",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry-run returns dry_run without calling create", async () => {
      const ctx = makeGetContext([]);
      const result = await manageDnsTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "new.lan",
          type: "A",
          address: "10.0.0.9",
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

describe("manage_dns_settings", () => {
  const manageDnsSettingsTool = dnsTools.find((t) => t.name === "manage_dns_settings")!;

  const CURRENT_SETTINGS = {
    ".id": "*1",
    servers: "8.8.8.8,8.8.4.4",
    "allow-remote-requests": "false",
    "max-udp-packet-size": "4096",
    "cache-max-ttl": "1w",
    "cache-size": "2048",
  };

  function makeSettingsContext(settings = CURRENT_SETTINGS) {
    return {
      routerId: "test-router",
      correlationId: "test-corr",
      routerConfig: {} as RouterConfig,
      sshClient: {} as SshClient,
      ftpClient: {} as FtpClient,
      identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
      routerClient: {
        get: vi.fn().mockResolvedValue([settings]),
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as RouterOSRestClient,
    } as unknown as ToolContext;
  }

  describe("metadata", () => {
    it("exists in dnsTools", () => expect(manageDnsSettingsTool).toBeDefined());
    it("is not readOnly", () => expect(manageDnsSettingsTool.annotations.readOnlyHint).toBe(false));
    it("is not destructive", () => expect(manageDnsSettingsTool.annotations.destructiveHint).toBe(false));
    it("is idempotent", () => expect(manageDnsSettingsTool.annotations.idempotentHint).toBe(true));
  });

  describe("input schema", () => {
    it("accepts minimal input", () => {
      expect(manageDnsSettingsTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true);
    });
    it("dryRun defaults false", () => {
      expect(manageDnsSettingsTool.inputSchema.parse({ routerId: "r1" }).dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(manageDnsSettingsTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
    it("rejects maxUdpPacketSize out of range", () => {
      expect(manageDnsSettingsTool.inputSchema.safeParse({ routerId: "r1", maxUdpPacketSize: 100 }).success).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns no_change when nothing differs", async () => {
      const ctx = makeSettingsContext();
      const result = await manageDnsSettingsTool.handler(
        { routerId: "test-router", servers: "8.8.8.8,8.8.4.4" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("updates changed fields", async () => {
      const ctx = makeSettingsContext();
      const result = await manageDnsSettingsTool.handler(
        { routerId: "test-router", servers: "1.1.1.1", allowRemoteRequests: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "ip/dns",
        "*1",
        expect.objectContaining({ servers: "1.1.1.1", "allow-remote-requests": "true" }),
      );
    });

    it("dry_run returns diff without calling update", async () => {
      const ctx = makeSettingsContext();
      const result = await manageDnsSettingsTool.handler(
        { routerId: "test-router", servers: "1.1.1.1", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("propagates network errors", async () => {
      const ctx = makeSettingsContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(manageDnsSettingsTool.handler({ routerId: "test-router" }, ctx)).rejects.toThrow();
    });
  });
});

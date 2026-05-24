import { describe, it, expect, vi } from "vitest";
import { networkServicesTools } from "../../../src/domain/tools/network-services-tools.js";
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

const [
  getSnmpSettingsTool,
  getNtpSettingsTool,
  listNetwatchEntriesTool,
  manageNetwatchEntryTool,
  listNeighborsTool,
  listArpEntriesTool,
] = networkServicesTools;

describe("networkServicesTools", () => {
  describe("metadata", () => {
    it("exports 7 tools", () => expect(networkServicesTools).toHaveLength(7));

    it("has correct tool names", () => {
      expect(getSnmpSettingsTool.name).toBe("get_snmp_settings");
      expect(getNtpSettingsTool.name).toBe("get_ntp_settings");
      expect(listNetwatchEntriesTool.name).toBe("list_netwatch_entries");
      expect(manageNetwatchEntryTool.name).toBe("manage_netwatch_entry");
      expect(listNeighborsTool.name).toBe("list_neighbors");
      expect(listArpEntriesTool.name).toBe("list_arp_entries");
    });

    it("read-only tools have readOnlyHint=true", () => {
      expect(getSnmpSettingsTool.annotations.readOnlyHint).toBe(true);
      expect(getNtpSettingsTool.annotations.readOnlyHint).toBe(true);
      expect(listNetwatchEntriesTool.annotations.readOnlyHint).toBe(true);
      expect(listNeighborsTool.annotations.readOnlyHint).toBe(true);
      expect(listArpEntriesTool.annotations.readOnlyHint).toBe(true);
    });

    it("manage_netwatch_entry has readOnlyHint=false", () =>
      expect(manageNetwatchEntryTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema — get_snmp_settings", () => {
    it("parses valid input", () => {
      const result = getSnmpSettingsTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("rejects extra fields", () => {
      const result = getSnmpSettingsTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — get_ntp_settings", () => {
    it("parses valid input", () => {
      const result = getNtpSettingsTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("rejects extra fields", () => {
      const result = getNtpSettingsTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — list_netwatch_entries", () => {
    it("parses valid input", () => {
      const result = listNetwatchEntriesTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listNetwatchEntriesTool.inputSchema.parse({ routerId: "r1" });
      expect((result as { limit: number }).limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listNetwatchEntriesTool.inputSchema.safeParse({
        routerId: "r1",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listNetwatchEntriesTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects invalid status", () => {
      const result = listNetwatchEntriesTool.inputSchema.safeParse({
        routerId: "r1",
        status: "flapping",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_netwatch_entry", () => {
    it("parses valid add input", () => {
      const result = manageNetwatchEntryTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        host: "8.8.8.8",
      });
      expect(result.success).toBe(true);
    });

    it("applies default dryRun=false", () => {
      const result = manageNetwatchEntryTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        host: "8.8.8.8",
      });
      expect((result as { dryRun: boolean }).dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageNetwatchEntryTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        host: "8.8.8.8",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageNetwatchEntryTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        host: "8.8.8.8",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — list_neighbors", () => {
    it("parses valid input", () => {
      const result = listNeighborsTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listNeighborsTool.inputSchema.parse({ routerId: "r1" });
      expect((result as { limit: number }).limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listNeighborsTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — list_arp_entries", () => {
    it("parses valid input", () => {
      const result = listArpEntriesTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listArpEntriesTool.inputSchema.parse({ routerId: "r1" });
      expect((result as { limit: number }).limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listArpEntriesTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listArpEntriesTool.inputSchema.safeParse({ routerId: "r1", limit: 600 });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — get_snmp_settings", () => {
    it("returns SNMP settings", async () => {
      const ctx = makeContext([{ ".id": "*1", enabled: "true", "trap-community": "public" }]);
      const result = await getSnmpSettingsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.routerId).toBe("test-router");
      expect(sc.settings).toBeDefined();
    });

    it("throws NOT_FOUND when array is empty", async () => {
      const ctx = makeContext([]);
      await expect(
        getSnmpSettingsTool.handler({ routerId: "test-router" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });
  });

  describe("handler — get_ntp_settings", () => {
    it("returns NTP settings", async () => {
      const ctx = makeContext([{ ".id": "*1", enabled: "true", servers: "pool.ntp.org" }]);
      const result = await getNtpSettingsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.routerId).toBe("test-router");
      expect(sc.settings).toBeDefined();
    });

    it("throws NOT_FOUND when array is empty", async () => {
      const ctx = makeContext([]);
      await expect(
        getNtpSettingsTool.handler({ routerId: "test-router" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });
  });

  describe("handler — list_netwatch_entries", () => {
    it("returns entries in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", host: "8.8.8.8", status: "up", disabled: "false" },
        { ".id": "*2", host: "1.1.1.1", status: "down", disabled: "false" },
      ]);
      const result = await listNetwatchEntriesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by host substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", host: "8.8.8.8", status: "up" },
        { ".id": "*2", host: "1.1.1.1", status: "up" },
      ]);
      const result = await listNetwatchEntriesTool.handler(
        { routerId: "test-router", host: "8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("filters by status", async () => {
      const ctx = makeContext([
        { ".id": "*1", host: "8.8.8.8", status: "up" },
        { ".id": "*2", host: "1.1.1.1", status: "down" },
      ]);
      const result = await listNetwatchEntriesTool.handler(
        { routerId: "test-router", status: "down" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", host: "8.8.8.8", status: "up" },
        { ".id": "*2", host: "1.1.1.1", status: "up" },
        { ".id": "*3", host: "9.9.9.9", status: "up" },
      ]);
      const result = await listNetwatchEntriesTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });
  });

  describe("handler — manage_netwatch_entry add", () => {
    it("creates entry when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "add", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "tool/netwatch",
        expect.objectContaining({ host: "8.8.8.8" }),
      );
    });

    it("returns already_exists for same host+port", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", port: "80" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "add", host: "8.8.8.8", port: 80 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("returns already_exists for same host with no port (ICMP)", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", port: "0" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "add", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("throws CONFLICT for same host, different port", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", port: "80" }]);
      await expect(
        manageNetwatchEntryTool.handler(
          { routerId: "test-router", action: "add", host: "8.8.8.8", port: 443 },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "add", host: "8.8.8.8", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_netwatch_entry remove", () => {
    it("removes entry when found", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", status: "up" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "remove", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("tool/netwatch", "*1");
    });

    it("returns not_found gracefully when already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "remove", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "remove", host: "8.8.8.8", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_netwatch_entry enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", disabled: "true" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "enable", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("tool/netwatch", "*1", {
        disabled: "false",
      });
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", disabled: "false" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "disable", host: "8.8.8.8" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("tool/netwatch", "*1", {
        disabled: "true",
      });
    });

    it("throws NOT_FOUND when entry does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageNetwatchEntryTool.handler(
          { routerId: "test-router", action: "enable", host: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", host: "8.8.8.8", disabled: "false" }]);
      const result = await manageNetwatchEntryTool.handler(
        { routerId: "test-router", action: "disable", host: "8.8.8.8", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — list_neighbors", () => {
    it("returns neighbors in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", interface: "ether1", address: "192.168.1.2", identity: "router-b" },
        { ".id": "*2", interface: "ether2", address: "192.168.2.2", identity: "router-c" },
      ]);
      const result = await listNeighborsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.neighbors as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by interface substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", interface: "ether1", address: "192.168.1.2" },
        { ".id": "*2", interface: "ether2", address: "192.168.2.2" },
      ]);
      const result = await listNeighborsTool.handler(
        { routerId: "test-router", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.neighbors as unknown[]).length).toBe(1);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", interface: "ether1", address: "192.168.1.2" },
        { ".id": "*2", interface: "ether2", address: "192.168.2.2" },
        { ".id": "*3", interface: "ether3", address: "192.168.3.2" },
      ]);
      const result = await listNeighborsTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.neighbors as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });
  });

  describe("manage_ntp_client", () => {
    const manageTool = networkServicesTools[6];

    it("has correct name", () => expect(manageTool.name).toBe("manage_ntp_client"));
    it("is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("is not destructive", () => expect(manageTool.annotations.destructiveHint).toBe(false));
    it("is idempotent", () => expect(manageTool.annotations.idempotentHint).toBe(true));

    describe("input schema", () => {
      it("parses valid input with enabled only", () => {
        expect(
          manageTool.inputSchema.safeParse({ routerId: "r1", enabled: true }).success,
        ).toBe(true);
      });
      it("dryRun defaults to false", () => {
        expect(manageTool.inputSchema.parse({ routerId: "r1", enabled: true }).dryRun).toBe(false);
      });
      it("rejects extra fields", () => {
        expect(
          manageTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success,
        ).toBe(false);
      });
      it("rejects invalid mode", () => {
        expect(
          manageTool.inputSchema.safeParse({ routerId: "r1", mode: "foobar" }).success,
        ).toBe(false);
      });
      it("validates mode enum", () => {
        expect(
          manageTool.inputSchema.safeParse({ routerId: "r1", mode: "unicast" }).success,
        ).toBe(true);
      });
    });

    function makeNtpContext(
      current: Record<string, unknown> = {
        ".id": "*1",
        enabled: "true",
        mode: "unicast",
        servers: "pool.ntp.org",
      },
    ): ToolContext {
      return {
        routerId: "test-router",
        correlationId: "test-corr",
        routerConfig: makeRouterConfig(),
        sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
        ftpClient: {
          upload: vi.fn().mockResolvedValue(undefined),
          connect: vi.fn().mockResolvedValue(undefined),
        } as unknown as FtpClient,
        identity: {
          id: "superadmin-builtin",
          name: "admin",
          role: "superadmin",
          allowedRouters: ["*"],
          allowedToolPatterns: ["*"],
        } as unknown as ToolContext["identity"],
        routerClient: {
          get: vi.fn().mockResolvedValue([current]),
          update: vi.fn().mockResolvedValue(undefined),
        } as unknown as RouterOSRestClient,
      };
    }

    it("returns already_set when no changes needed", async () => {
      const ctx = makeNtpContext({
        ".id": "*1",
        enabled: "true",
        mode: "unicast",
        servers: "pool.ntp.org",
      });
      const result = await manageTool.handler(
        { routerId: "test-router", enabled: true, mode: "unicast", servers: "pool.ntp.org" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_set");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("updates enabled field", async () => {
      const ctx = makeNtpContext({ ".id": "*1", enabled: "true", mode: "unicast" });
      const result = await manageTool.handler(
        { routerId: "test-router", enabled: false },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "system/ntp/client",
        "*1",
        expect.objectContaining({ enabled: "false" }),
      );
    });

    it("updates servers field", async () => {
      const ctx = makeNtpContext({ ".id": "*1", enabled: "true", servers: "old.ntp.org" });
      const result = await manageTool.handler(
        { routerId: "test-router", servers: "0.pool.ntp.org,1.pool.ntp.org" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "system/ntp/client",
        "*1",
        expect.objectContaining({ servers: "0.pool.ntp.org,1.pool.ntp.org" }),
      );
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeNtpContext({ ".id": "*1", enabled: "true" });
      const result = await manageTool.handler(
        { routerId: "test-router", enabled: false, dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — list_arp_entries", () => {
    it("returns ARP entries in structuredContent", async () => {
      const ctx = makeContext([
        {
          ".id": "*1",
          address: "192.168.1.1",
          "mac-address": "AA:BB:CC:DD:EE:01",
          interface: "ether1",
          dynamic: "true",
        },
        {
          ".id": "*2",
          address: "192.168.1.2",
          "mac-address": "AA:BB:CC:DD:EE:02",
          interface: "ether2",
          dynamic: "true",
        },
      ]);
      const result = await listArpEntriesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by interface substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", address: "192.168.1.1", "mac-address": "AA:BB:CC:DD:EE:01", interface: "ether1" },
        { ".id": "*2", address: "192.168.1.2", "mac-address": "AA:BB:CC:DD:EE:02", interface: "ether2" },
      ]);
      const result = await listArpEntriesTool.handler(
        { routerId: "test-router", interface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("filters by address substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", address: "192.168.1.1", "mac-address": "AA:BB:CC:DD:EE:01", interface: "ether1" },
        { ".id": "*2", address: "10.0.0.1", "mac-address": "AA:BB:CC:DD:EE:02", interface: "ether2" },
      ]);
      const result = await listArpEntriesTool.handler(
        { routerId: "test-router", address: "192.168" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("filters by macAddress substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", address: "192.168.1.1", "mac-address": "AA:BB:CC:DD:EE:01", interface: "ether1" },
        { ".id": "*2", address: "192.168.1.2", "mac-address": "FF:FF:FF:FF:FF:FF", interface: "ether2" },
      ]);
      const result = await listArpEntriesTool.handler(
        { routerId: "test-router", macAddress: "AA:BB" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(1);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", address: "192.168.1.1", "mac-address": "AA:BB:CC:DD:EE:01", interface: "ether1" },
        { ".id": "*2", address: "192.168.1.2", "mac-address": "AA:BB:CC:DD:EE:02", interface: "ether2" },
        { ".id": "*3", address: "192.168.1.3", "mac-address": "AA:BB:CC:DD:EE:03", interface: "ether3" },
      ]);
      const result = await listArpEntriesTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.entries as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });
  });
});

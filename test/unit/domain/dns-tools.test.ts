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
        { ".id": "*1", name: "host.lan", type: "A", address: "10.0.0.5", disabled: false },
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

    // Records as the REST response parser returns them: "false" becomes a
    // boolean and numeric strings become numbers.
    const ROUTER_LAN = {
      ".id": "*1",
      name: "router.lan",
      type: "A",
      address: "192.168.1.1",
      ttl: "1d",
      comment: "defconf",
      disabled: false,
      dynamic: false,
    };

    async function addError(ctx: ToolContext, params: Record<string, unknown>) {
      return manageDnsTool
        .handler({ routerId: "test-router", action: "add", ...params }, ctx)
        .catch((err: unknown) => err);
    }

    it("throws DNS_ENTRY_CONFLICT when an A record with the name has another address", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, { name: "router.lan", address: "192.168.1.2" });

      expect(error).toMatchObject({
        category: ErrorCategory.CONFLICT,
        code: "DNS_ENTRY_CONFLICT",
        details: {
          existing: [{ address: "192.168.1.1", disabled: false, ttl: "1d", comment: "defconf" }],
          requested: { address: "192.168.1.2", disabled: "false" },
        },
      });
      // The model sees only the message, so it must carry both values.
      expect((error as Error).message).toContain("address=192.168.1.1");
      expect((error as Error).message).toContain("address=192.168.1.2");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry-run add reports the same CONFLICT", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, {
        name: "router.lan",
        address: "192.168.1.2",
        dryRun: true,
      });
      expect(error).toMatchObject({ code: "DNS_ENTRY_CONFLICT" });
    });

    it("throws DNS_ENTRY_CONFLICT when only the disabled state differs", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, {
        name: "router.lan",
        address: "192.168.1.1",
        disabled: true,
      });
      expect(error).toMatchObject({ code: "DNS_ENTRY_CONFLICT" });
    });

    it("ignores ttl and comment when they are not requested", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const result = await manageDnsTool.handler(
        { routerId: "test-router", action: "add", name: "router.lan", address: "192.168.1.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it.each([
      ["24h", "1d"],
      ["1d 00:00:00", "1d"],
      ["00:05:00", "5m"],
      ["300", "5m"],
      ["1w", "7d"],
      ["90s", "1m30s"],
    ])("treats ttl %s as equal to the stored %s", async (requested, stored) => {
      const ctx = makeGetContext([{ ...ROUTER_LAN, ttl: stored }]);
      const result = await manageDnsTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "router.lan",
          address: "192.168.1.1",
          ttl: requested,
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("throws DNS_ENTRY_CONFLICT when a requested ttl differs", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, { name: "router.lan", address: "192.168.1.1", ttl: "1h" });
      expect(error).toMatchObject({ code: "DNS_ENTRY_CONFLICT" });
      expect((error as Error).message).toContain("ttl=1h");
    });

    it("throws DNS_ENTRY_CONFLICT when a requested comment differs", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, {
        name: "router.lan",
        address: "192.168.1.1",
        comment: "gateway",
      });
      expect(error).toMatchObject({ code: "DNS_ENTRY_CONFLICT" });
    });

    it("returns the matching record when several share the name (round-robin)", async () => {
      const second = { ...ROUTER_LAN, ".id": "*2", address: "192.168.1.2" };
      const ctx = makeGetContext([ROUTER_LAN, second]);
      const result = await manageDnsTool.handler(
        { routerId: "test-router", action: "add", name: "router.lan", address: "192.168.1.2" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(sc.entry).toBe(second);
    });

    it("lists every record with the name in a CONFLICT", async () => {
      const second = { ...ROUTER_LAN, ".id": "*2", address: "192.168.1.2" };
      const ctx = makeGetContext([ROUTER_LAN, second]);
      const error = await addError(ctx, { name: "router.lan", address: "192.168.1.3" });
      expect(error).toMatchObject({
        code: "DNS_ENTRY_CONFLICT",
        details: { existing: [{ address: "192.168.1.1" }, { address: "192.168.1.2" }] },
      });
    });

    it("compares CNAME and TXT values, including a TXT value parsed as a number", async () => {
      const cnameCtx = makeGetContext([
        { ".id": "*3", name: "www.lan", type: "CNAME", cname: "host.lan", disabled: false },
      ]);
      await expect(
        addError(cnameCtx, { name: "www.lan", type: "CNAME", cname: "other.lan" }),
      ).resolves.toMatchObject({ code: "DNS_ENTRY_CONFLICT" });

      const txtCtx = makeGetContext([
        { ".id": "*4", name: "txt.lan", type: "TXT", text: 42, disabled: false },
      ]);
      const result = await manageDnsTool.handler(
        { routerId: "test-router", action: "add", name: "txt.lan", type: "TXT", text: "42" },
        txtCtx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("rejects an A record without an address even when the name exists", async () => {
      const ctx = makeGetContext([ROUTER_LAN]);
      const error = await addError(ctx, { name: "router.lan" });
      expect(error).toMatchObject({ code: "DNS_MISSING_ADDRESS" });
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

  // DNS settings are a set-menu singleton — real responses carry no ".id".
  const CURRENT_SETTINGS = {
    servers: "8.8.8.8,8.8.4.4",
    "allow-remote-requests": "false",
    "max-udp-packet-size": "4096",
    "cache-max-ttl": "1w",
    "cache-size": "2048",
  };

  function makeSettingsContext(settings: Record<string, unknown> = CURRENT_SETTINGS) {
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
        get: vi.fn().mockResolvedValue([settings]),
        execute: vi.fn().mockResolvedValue(undefined),
      } as unknown as RouterOSRestClient,
    } as unknown as ToolContext;
  }

  describe("metadata", () => {
    it("exists in dnsTools", () => expect(manageDnsSettingsTool).toBeDefined());
    it("is not readOnly", () => expect(manageDnsSettingsTool.annotations.readOnlyHint).toBe(false));
    it("is destructive (DNS changes can break resolution)", () =>
      expect(manageDnsSettingsTool.annotations.destructiveHint).toBe(true));
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
      expect(
        manageDnsSettingsTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success,
      ).toBe(false);
    });
    it("rejects maxUdpPacketSize out of range", () => {
      expect(
        manageDnsSettingsTool.inputSchema.safeParse({ routerId: "r1", maxUdpPacketSize: 100 })
          .success,
      ).toBe(false);
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
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("returns no_change when the record carries parsed boolean/number fields", async () => {
      // The response parser converts wire strings to typed values — the change
      // detection must not report a spurious update.
      const ctx = makeSettingsContext({
        ...CURRENT_SETTINGS,
        "allow-remote-requests": false,
        "max-udp-packet-size": 4096,
        "cache-size": 2048,
      });
      const result = await manageDnsSettingsTool.handler(
        {
          routerId: "test-router",
          allowRemoteRequests: false,
          maxUdpPacketSize: 4096,
          cacheSize: 2048,
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("updates changed fields via the /set command", async () => {
      const ctx = makeSettingsContext();
      const result = await manageDnsSettingsTool.handler(
        { routerId: "test-router", servers: "1.1.1.1", allowRemoteRequests: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "ip/dns/set",
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
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("propagates network errors", async () => {
      const ctx = makeSettingsContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(
        manageDnsSettingsTool.handler({ routerId: "test-router" }, ctx),
      ).rejects.toThrow();
    });
  });
});

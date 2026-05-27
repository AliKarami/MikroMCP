import { describe, it, expect, vi } from "vitest";
import { ipsecTools } from "../../../src/domain/tools/ipsec-tools.js";
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

function makeContext(peers: Record<string, unknown>[] = []): ToolContext {
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
      get: vi.fn().mockResolvedValue(peers),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "test-peer" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listPeersTool, listPoliciesTool, managePeerTool] = ipsecTools;

describe("manage_ipsec_policy", () => {
  const managePolicyTool = ipsecTools.find((t) => t.name === "manage_ipsec_policy")!;

  const POLICY = {
    ".id": "*1",
    "src-address": "10.0.0.0/24",
    "dst-address": "192.168.1.0/24",
    tunnel: "true",
    action: "encrypt",
    level: "require",
    disabled: "false",
  };

  function makePolicyContext(policies: Record<string, unknown>[] = []) {
    return {
      routerId: "test-router",
      correlationId: "test-corr",
      routerConfig: {} as RouterConfig,
      sshClient: {} as SshClient,
      ftpClient: {} as FtpClient,
      identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
      routerClient: {
        get: vi.fn().mockResolvedValue(policies),
        create: vi.fn().mockResolvedValue({ ".id": "*2" }),
        update: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as RouterOSRestClient,
    } as unknown as ToolContext;
  }

  describe("metadata", () => {
    it("exists in ipsecTools", () => expect(managePolicyTool).toBeDefined());
    it("is not readOnly", () => expect(managePolicyTool.annotations.readOnlyHint).toBe(false));
    it("is not destructive", () => expect(managePolicyTool.annotations.destructiveHint).toBe(false));
  });

  describe("input schema", () => {
    it("parses valid add input", () => {
      expect(managePolicyTool.inputSchema.safeParse({
        routerId: "r1", action: "add",
        srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", ipsecAction: "encrypt",
      }).success).toBe(true);
    });
    it("tunnel defaults false", () => {
      expect(managePolicyTool.inputSchema.parse({
        routerId: "r1", action: "add",
        srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", ipsecAction: "encrypt",
      }).tunnel).toBe(false);
    });
    it("rejects invalid action", () => {
      expect(managePolicyTool.inputSchema.safeParse({ routerId: "r1", action: "update", srcAddress: "0.0.0.0/0", dstAddress: "0.0.0.0/0" }).success).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(managePolicyTool.inputSchema.safeParse({ routerId: "r1", action: "remove", srcAddress: "0.0.0.0/0", dstAddress: "0.0.0.0/0", extra: true }).success).toBe(false);
    });
  });

  describe("handler — add", () => {
    it("creates policy when not found", async () => {
      const ctx = makePolicyContext([]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "add", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", tunnel: true, ipsecAction: "encrypt" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("ip/ipsec/policy", expect.objectContaining({ "src-address": "10.0.0.0/24", "dst-address": "192.168.1.0/24" }));
    });

    it("returns already_exists when policy matches", async () => {
      const ctx = makePolicyContext([POLICY]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "add", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", tunnel: true, ipsecAction: "encrypt" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makePolicyContext([]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "add", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", ipsecAction: "encrypt", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — remove", () => {
    it("removes policy when found", async () => {
      const ctx = makePolicyContext([POLICY]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "remove", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", tunnel: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/ipsec/policy", "*1");
    });

    it("returns not_found gracefully when already gone", async () => {
      const ctx = makePolicyContext([]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "remove", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });
  });

  describe("handler — enable/disable", () => {
    it("disables a policy", async () => {
      const ctx = makePolicyContext([POLICY]);
      const result = await managePolicyTool.handler(
        { routerId: "test-router", action: "disable", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24", tunnel: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ip/ipsec/policy", "*1", { disabled: "true" });
    });

    it("throws NOT_FOUND on enable/disable when missing", async () => {
      const { ErrorCategory } = await import("../../../src/domain/errors/error-types.js");
      const ctx = makePolicyContext([]);
      await expect(
        managePolicyTool.handler({ routerId: "test-router", action: "enable", srcAddress: "10.0.0.0/24", dstAddress: "192.168.1.0/24" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });
  });
});

describe("ipsecTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => expect(ipsecTools).toHaveLength(4));

    it("has correct tool names", () => {
      expect(listPeersTool.name).toBe("list_ipsec_peers");
      expect(listPoliciesTool.name).toBe("list_ipsec_policies");
      expect(managePeerTool.name).toBe("manage_ipsec_peer");
    });

    it("list_ipsec_peers is readOnly", () =>
      expect(listPeersTool.annotations.readOnlyHint).toBe(true));

    it("list_ipsec_policies is readOnly", () =>
      expect(listPoliciesTool.annotations.readOnlyHint).toBe(true));

    it("manage_ipsec_peer is not readOnly", () =>
      expect(managePeerTool.annotations.readOnlyHint).toBe(false));

    it("manage_ipsec_peer is destructive", () =>
      expect(managePeerTool.annotations.destructiveHint).toBe(true));
  });

  describe("input schema — list_ipsec_peers", () => {
    it("parses valid input", () => {
      const result = listPeersTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listPeersTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listPeersTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listPeersTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — list_ipsec_policies", () => {
    it("parses valid input", () => {
      const result = listPoliciesTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listPoliciesTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listPoliciesTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_ipsec_peer", () => {
    it("parses valid add input", () => {
      const result = managePeerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vpn-peer",
        address: "1.2.3.4",
      });
      expect(result.success).toBe(true);
    });

    it("applies defaults: exchange=ike2, dryRun=false", () => {
      const result = managePeerTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        name: "vpn-peer",
      });
      expect(result.exchange).toBe("ike2");
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = managePeerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "vpn-peer",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = managePeerTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        name: "vpn-peer",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_ipsec_peers", () => {
    it("returns peers in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "peer1", address: "10.0.0.1", exchange: "ike2" },
        { ".id": "*2", name: "peer2", address: "10.0.0.2", exchange: "ike1" },
      ]);
      const result = await listPeersTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.peers as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by address substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "peer1", address: "10.0.0.1" },
        { ".id": "*2", name: "peer2", address: "192.168.1.1" },
      ]);
      const result = await listPeersTool.handler(
        { routerId: "test-router", address: "192.168" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.peers as unknown[]).length).toBe(1);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "peer1", address: "10.0.0.1" },
        { ".id": "*2", name: "peer2", address: "10.0.0.2" },
        { ".id": "*3", name: "peer3", address: "10.0.0.3" },
      ]);
      const result = await listPeersTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.peers as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });

    it("throws enriched error on failure", async () => {
      const ctx = makeContext([]);
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error"),
      );
      await expect(
        listPeersTool.handler({ routerId: "test-router" }, ctx),
      ).rejects.toThrow();
    });
  });

  describe("handler — list_ipsec_policies", () => {
    it("returns policies in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", "src-address": "10.0.0.0/24", "dst-address": "192.168.1.0/24" },
      ]);
      const result = await listPoliciesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.policies as unknown[]).length).toBe(1);
    });

    it("filters by srcAddress substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", "src-address": "10.0.0.0/24", "dst-address": "192.168.1.0/24" },
        { ".id": "*2", "src-address": "172.16.0.0/16", "dst-address": "192.168.2.0/24" },
      ]);
      const result = await listPoliciesTool.handler(
        { routerId: "test-router", srcAddress: "10.0.0" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.policies as unknown[]).length).toBe(1);
    });

    it("filters by dstAddress substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", "src-address": "10.0.0.0/24", "dst-address": "192.168.1.0/24" },
        { ".id": "*2", "src-address": "172.16.0.0/16", "dst-address": "192.168.2.0/24" },
      ]);
      const result = await listPoliciesTool.handler(
        { routerId: "test-router", dstAddress: "192.168.2" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.policies as unknown[]).length).toBe(1);
    });

    it("applies both filters together", async () => {
      const ctx = makeContext([
        { ".id": "*1", "src-address": "10.0.0.0/24", "dst-address": "192.168.1.0/24" },
        { ".id": "*2", "src-address": "10.0.0.0/24", "dst-address": "192.168.2.0/24" },
      ]);
      const result = await listPoliciesTool.handler(
        { routerId: "test-router", srcAddress: "10.0.0", dstAddress: "192.168.1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.policies as unknown[]).length).toBe(1);
    });
  });

  describe("handler — manage_ipsec_peer add", () => {
    it("creates peer when not found", async () => {
      const ctx = makeContext([]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "add", name: "vpn1", address: "1.2.3.4" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("ip/ipsec/peer", expect.objectContaining({
        name: "vpn1",
        address: "1.2.3.4",
      }));
    });

    it("returns already_exists when peer found with same address", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", address: "1.2.3.4" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "add", name: "vpn1", address: "1.2.3.4" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when peer found with different address", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", address: "5.5.5.5" }]);
      await expect(
        managePeerTool.handler(
          { routerId: "test-router", action: "add", name: "vpn1", address: "1.2.3.4" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await managePeerTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "vpn1",
          address: "1.2.3.4",
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws VALIDATION error when address is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        managePeerTool.handler(
          { routerId: "test-router", action: "add", name: "vpn1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("throws VALIDATION error when address is missing even with dryRun=true", async () => {
      const ctx = makeContext([]);
      await expect(
        managePeerTool.handler(
          { routerId: "test-router", action: "add", name: "vpn1", dryRun: true },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });
  });

  describe("handler — manage_ipsec_peer remove", () => {
    it("removes peer when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", address: "1.2.3.4" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "remove", name: "vpn1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ip/ipsec/peer", "*1");
    });

    it("returns not_found when peer already gone", async () => {
      const ctx = makeContext([]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "remove", name: "vpn1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", address: "1.2.3.4" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "remove", name: "vpn1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_ipsec_peer enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", disabled: "true" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "enable", name: "vpn1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "ip/ipsec/peer",
        "*1",
        { disabled: "false" },
      );
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", disabled: "false" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "disable", name: "vpn1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "ip/ipsec/peer",
        "*1",
        { disabled: "true" },
      );
    });

    it("throws NOT_FOUND when peer does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        managePeerTool.handler(
          { routerId: "test-router", action: "enable", name: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vpn1", disabled: "false" }]);
      const result = await managePeerTool.handler(
        { routerId: "test-router", action: "disable", name: "vpn1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

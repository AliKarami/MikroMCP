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

describe("wireguardTools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => expect(wireguardTools).toHaveLength(3));
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

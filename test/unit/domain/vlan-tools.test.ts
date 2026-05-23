import { describe, it, expect, vi } from "vitest";
import { vlanTools } from "../../../src/domain/tools/vlan-tools.js";
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
    ftpClient: { upload: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "vlan10", "vlan-id": "10" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [manageTool] = vlanTools;

describe("vlanTools", () => {
  describe("metadata", () => {
    it("exports 1 tool", () => expect(vlanTools).toHaveLength(1));
    it("tool is named manage_vlan", () => expect(manageTool.name).toBe("manage_vlan"));
    it("is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("has snapshotPaths", () => expect(manageTool.snapshotPaths).toContain("interface/vlan"));
  });

  describe("manage_vlan - add", () => {
    it("creates vlan when not existing", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10, parentInterface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
    });

    it("returns already_exists when vlan with same name, vlanId, parentInterface exists", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1", disabled: "false" },
      ]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10, parentInterface: "ether1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("idempotency handles RouterOS boolean disabled=false (string)", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1", disabled: "false" },
      ]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10, parentInterface: "ether1", disabled: false },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("throws CONFLICT when vlan exists with different config", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "vlan10", "vlan-id": "20", interface: "ether1", disabled: "false" },
      ]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10, parentInterface: "ether1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION when vlanId is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "vlan10", parentInterface: "ether1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("throws VALIDATION when parentInterface is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10 },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("dry_run returns diff without creating", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "vlan10", vlanId: 10, parentInterface: "ether1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("manage_vlan - remove", () => {
    it("removes existing vlan", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "vlan10" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/vlan", "*1");
    });

    it("returns not_found when vlan missing on remove", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "vlan99" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "vlan10", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("manage_vlan - enable/disable", () => {
    it("disables an existing vlan", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "vlan10" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/vlan", "*1", { disabled: "true" });
    });

    it("enables an existing vlan", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1", disabled: "true" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", name: "vlan10" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/vlan", "*1", { disabled: "false" });
    });

    it("throws NOT_FOUND on enable/disable when vlan missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "enable", name: "vlan99" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns diff without updating", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "vlan10", "vlan-id": "10", interface: "ether1", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "vlan10", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

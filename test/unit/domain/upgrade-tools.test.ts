import { describe, it, expect, vi } from "vitest";
import { upgradeTools } from "../../../src/domain/tools/upgrade-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig, Identity } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";

const UPDATE_RECORD = {
  ".id": "*1",
  channel: "stable",
  "installed-version": "7.12.1",
  "latest-version": "7.14.2",
  status: "New version is available",
};

const ROUTERBOARD_RECORD = {
  ".id": "*1",
  routerboard: "yes",
  model: "RB750Gr3",
  "firmware-type": "ipq4000L",
  "factory-firmware": "3.49",
  "current-firmware": "7.12.1",
  "upgrade-firmware": "7.14.2",
};

function makeContext(
  updateRecords: Record<string, unknown>[] = [UPDATE_RECORD],
  routerboardRecords: Record<string, unknown>[] = [ROUTERBOARD_RECORD],
): ToolContext {
  const getMock = vi.fn().mockImplementation((path: string) => {
    if (path === "system/package/update") return Promise.resolve(updateRecords);
    if (path === "system/routerboard") return Promise.resolve(routerboardRecords);
    return Promise.resolve([]);
  });
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: {} as RouterConfig,
    sshClient: {} as SshClient,
    ftpClient: {} as FtpClient,
    identity: {
      id: "superadmin-builtin",
      name: "admin",
      role: "superadmin",
      allowedRouters: ["*"],
      allowedToolPatterns: ["*"],
    } as unknown as Identity,
    routerClient: {
      get: getMock,
      execute: vi.fn().mockResolvedValue({ status: "triggered" }),
    } as unknown as RouterOSRestClient,
    appConfig: {} as never,
  };
}

const [getStatusTool, manageTool] = upgradeTools;

describe("upgradeTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(upgradeTools).toHaveLength(2));
    it("has correct names", () => {
      expect(getStatusTool.name).toBe("get_upgrade_status");
      expect(manageTool.name).toBe("manage_upgrade");
    });
    it("get_upgrade_status is readOnly", () =>
      expect(getStatusTool.annotations.readOnlyHint).toBe(true));
    it("manage_upgrade is not readOnly", () =>
      expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("manage_upgrade is destructive", () =>
      expect(manageTool.annotations.destructiveHint).toBe(true));
  });

  describe("input schema — get_upgrade_status", () => {
    it("parses valid input", () => {
      expect(getStatusTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true);
    });
    it("rejects extra fields", () => {
      expect(
        getStatusTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success,
      ).toBe(false);
    });
  });

  describe("input schema — manage_upgrade", () => {
    it("parses valid check input", () => {
      expect(
        manageTool.inputSchema.safeParse({ routerId: "r1", action: "check" }).success,
      ).toBe(true);
    });
    it("dryRun defaults to false", () => {
      expect(manageTool.inputSchema.parse({ routerId: "r1", action: "check" }).dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(
        manageTool.inputSchema.safeParse({ routerId: "r1", action: "check", extra: true }).success,
      ).toBe(false);
    });
    it("rejects invalid action", () => {
      expect(
        manageTool.inputSchema.safeParse({ routerId: "r1", action: "download" }).success,
      ).toBe(false);
    });
  });

  describe("handler — get_upgrade_status", () => {
    it("returns update status and routerboard info", async () => {
      const ctx = makeContext();
      const result = await getStatusTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.routerId).toBe("test-router");
      expect(sc.installedVersion).toBe("7.12.1");
      expect(sc.latestVersion).toBe("7.14.2");
      expect(sc.channel).toBe("stable");
    });

    it("handles missing routerboard gracefully", async () => {
      const ctx = makeContext([UPDATE_RECORD], []);
      const result = await getStatusTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.routerboard).toBeNull();
    });

    it("throws enriched error on network failure", async () => {
      const ctx = makeContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(getStatusTool.handler({ routerId: "test-router" }, ctx)).rejects.toThrow();
    });
  });

  describe("handler — manage_upgrade check", () => {
    it("calls check-for-updates endpoint", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler({ routerId: "test-router", action: "check" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("check_triggered");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "system/package/update/check-for-updates",
      );
    });

    it("dry_run returns preview without calling execute", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "check", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_upgrade install", () => {
    it("calls install endpoint", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "install" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("install_triggered");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith("system/package/update/install");
    });

    it("dry_run returns preview without calling execute", async () => {
      const ctx = makeContext();
      const result = await manageTool.handler(
        { routerId: "test-router", action: "install", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });
  });
});

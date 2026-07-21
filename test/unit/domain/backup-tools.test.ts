import { describe, it, expect, vi } from "vitest";
import { backupTools } from "../../../src/domain/tools/backup-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig, Identity } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";

function makeContext(
  restExecuteResult: unknown = {},
  sshExecuteResult: string = "# RouterOS export\n/ip address add address=1.2.3.4/24",
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: {} as RouterConfig,
    sshClient: {
      execute: vi.fn().mockResolvedValue(sshExecuteResult),
    } as unknown as SshClient,
    ftpClient: {} as FtpClient,
    identity: {
      id: "superadmin-builtin",
      name: "admin",
      role: "superadmin",
      allowedRouters: ["*"],
      allowedToolPatterns: ["*"],
    } as unknown as Identity,
    routerClient: {
      execute: vi.fn().mockResolvedValue(restExecuteResult),
    } as unknown as RouterOSRestClient,
  };
}

const [createBackupTool, exportConfigTool] = backupTools;

describe("backupTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(backupTools).toHaveLength(2));
    it("has correct names", () => {
      expect(createBackupTool.name).toBe("create_backup");
      expect(exportConfigTool.name).toBe("export_config");
    });
    it("create_backup is not readOnly", () => expect(createBackupTool.annotations.readOnlyHint).toBe(false));
    it("create_backup is not destructive", () => expect(createBackupTool.annotations.destructiveHint).toBe(false));
    it("export_config is not read-only (writes a file with `file` arg)", () => expect(exportConfigTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema — create_backup", () => {
    it("parses valid input with defaults", () => {
      const result = createBackupTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });
    it("rejects extra fields", () => {
      expect(createBackupTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
    it("dryRun defaults to false", () => {
      expect(createBackupTool.inputSchema.parse({ routerId: "r1" }).dryRun).toBe(false);
    });
    it("name defaults to 'backup'", () => {
      expect(createBackupTool.inputSchema.parse({ routerId: "r1" }).name).toBe("backup");
    });
  });

  describe("input schema — export_config", () => {
    it("parses valid minimal input", () => {
      expect(exportConfigTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true);
    });
    it("rejects extra fields", () => {
      expect(exportConfigTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
    it("compact defaults to false", () => {
      expect(exportConfigTool.inputSchema.parse({ routerId: "r1" }).compact).toBe(false);
    });
  });

  describe("handler — create_backup", () => {
    it("calls backup save with default name", async () => {
      const ctx = makeContext({ name: "backup" });
      const result = await createBackupTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "system/backup/save",
        expect.objectContaining({ name: "backup" }),
      );
    });

    it("uses provided name", async () => {
      const ctx = makeContext({ name: "my-backup" });
      await createBackupTool.handler({ routerId: "test-router", name: "my-backup" }, ctx);
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "system/backup/save",
        expect.objectContaining({ name: "my-backup" }),
      );
    });

    it("includes password param when provided", async () => {
      const ctx = makeContext({});
      await createBackupTool.handler(
        { routerId: "test-router", name: "safe-backup", password: "secret" },
        ctx,
      );
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "system/backup/save",
        expect.objectContaining({ password: "secret" }),
      );
    });

    it("never includes password in structuredContent", async () => {
      const ctx = makeContext({});
      const result = await createBackupTool.handler(
        { routerId: "test-router", name: "safe-backup", password: "topsecret" },
        ctx,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain("topsecret");
    });

    it("dry_run returns preview without calling execute", async () => {
      const ctx = makeContext({});
      const result = await createBackupTool.handler(
        { routerId: "test-router", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });
  });

  describe("handler — export_config", () => {
    it("uses SSH for inline export and returns script text", async () => {
      const ctx = makeContext({}, "# RouterOS export\n/ip address add address=1.2.3.4/24");
      const result = await exportConfigTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(typeof sc.script).toBe("string");
      expect((sc.script as string).length).toBeGreaterThan(0);
      expect(ctx.sshClient.execute).toHaveBeenCalledWith("export");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("passes 'export compact' over SSH when compact=true", async () => {
      const ctx = makeContext({}, "# compact export");
      await exportConfigTool.handler({ routerId: "test-router", compact: true }, ctx);
      expect(ctx.sshClient.execute).toHaveBeenCalledWith("export compact");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("uses SSH with plain 'export' when compact=false", async () => {
      const ctx = makeContext({}, "# full export");
      await exportConfigTool.handler({ routerId: "test-router", compact: false }, ctx);
      expect(ctx.sshClient.execute).toHaveBeenCalledWith("export");
      expect(ctx.routerClient.execute).not.toHaveBeenCalled();
    });

    it("saves to file when provided", async () => {
      const ctx = makeContext("");
      const result = await exportConfigTool.handler({ routerId: "test-router", file: "my-config" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.filePath).toBe("my-config.rsc");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "system/export",
        expect.objectContaining({ file: "my-config" }),
      );
    });

    it("does not include script in response when file is provided", async () => {
      const ctx = makeContext("# export");
      const result = await exportConfigTool.handler({ routerId: "test-router", file: "config" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty("script");
    });
  });
});

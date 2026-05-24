import { describe, it, expect, vi } from "vitest";
import { userGroupTools } from "../../../src/domain/tools/user-group-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig, Identity } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

function makeContext(groups: Record<string, unknown>[] = []): ToolContext {
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
      get: vi.fn().mockResolvedValue(groups),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "ops" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = userGroupTools;

describe("userGroupTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(userGroupTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_user_groups");
      expect(manageTool.name).toBe("manage_user_group");
    });
    it("list_user_groups is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_user_group is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("manage_user_group is not destructive", () => expect(manageTool.annotations.destructiveHint).toBe(false));
  });

  describe("input schema — list_user_groups", () => {
    it("parses valid input", () => {
      expect(listTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true);
    });
    it("applies default limit 100", () => {
      expect(listTool.inputSchema.parse({ routerId: "r1" }).limit).toBe(100);
    });
    it("rejects extra fields", () => {
      expect(listTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
    it("rejects limit out of range", () => {
      expect(listTool.inputSchema.safeParse({ routerId: "r1", limit: 0 }).success).toBe(false);
    });
  });

  describe("input schema — manage_user_group", () => {
    it("parses valid add input", () => {
      expect(
        manageTool.inputSchema.safeParse({
          routerId: "r1", action: "add", name: "ops", policy: "read,write",
        }).success,
      ).toBe(true);
    });
    it("dryRun defaults to false", () => {
      expect(
        manageTool.inputSchema.parse({ routerId: "r1", action: "add", name: "ops" }).dryRun,
      ).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(
        manageTool.inputSchema.safeParse({
          routerId: "r1", action: "add", name: "ops", extra: true,
        }).success,
      ).toBe(false);
    });
    it("rejects invalid action", () => {
      expect(
        manageTool.inputSchema.safeParse({ routerId: "r1", action: "enable", name: "ops" }).success,
      ).toBe(false);
    });
  });

  describe("handler — list_user_groups", () => {
    it("returns all groups", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "full", policy: "ftp,reboot,read,write,policy" },
        { ".id": "*2", name: "read", policy: "ftp,read,test,winbox" },
      ]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.groups as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("throws enriched error on network failure", async () => {
      const ctx = makeContext([]);
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(listTool.handler({ routerId: "test-router" }, ctx)).rejects.toThrow();
    });
  });

  describe("handler — manage_user_group add", () => {
    it("creates group when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "ops", policy: "read,write" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "user/group",
        expect.objectContaining({ name: "ops", policy: "read,write" }),
      );
    });

    it("returns already_exists when group found with same policy", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read,write" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "ops", policy: "read,write" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when group found with different policy", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read" }]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "ops", policy: "read,write" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "ops", policy: "read", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_user_group update", () => {
    it("updates policy when group exists", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "ops", policy: "read,write" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("user/group", "*1", { policy: "read,write" });
    });

    it("returns no_change when policy unchanged", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read,write" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "ops", policy: "read,write" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });

    it("throws NOT_FOUND when group does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "update", name: "ops", policy: "read" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "update", name: "ops", policy: "read,write", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_user_group remove", () => {
    it("removes group when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "ops" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("user/group", "*1");
    });

    it("returns not_found gracefully when already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "ops" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "ops", policy: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "ops", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });
});

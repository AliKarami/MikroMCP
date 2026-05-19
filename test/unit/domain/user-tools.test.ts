import { describe, it, expect, vi } from "vitest";
import { userTools } from "../../../src/domain/tools/user-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig, Identity } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

function makeContext(users: Record<string, unknown>[] = []): ToolContext {
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
      get: vi.fn().mockResolvedValue(users),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "alice" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = userTools;

describe("userTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(userTools).toHaveLength(2));

    it("has correct tool names", () => {
      expect(listTool.name).toBe("list_users");
      expect(manageTool.name).toBe("manage_user");
    });

    it("list_users is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));

    it("manage_user is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));

    it("manage_user is not destructive", () =>
      expect(manageTool.annotations.destructiveHint).toBe(false));
  });

  describe("input schema — list_users", () => {
    it("parses valid input", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_user", () => {
    it("parses valid add input", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "alice",
        group: "read",
        password: "secret123",
      });
      expect(result.success).toBe(true);
    });

    it("dryRun defaults to false", () => {
      const result = manageTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        name: "alice",
      });
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "alice",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        name: "alice",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_users", () => {
    it("returns users without password field", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "alice", group: "full", password: "secret", disabled: "false" },
        { ".id": "*2", name: "bob", group: "read", password: "hunter2", disabled: "false" },
      ]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const users = sc.users as Record<string, unknown>[];
      expect(users.length).toBe(2);
      expect(sc.total).toBe(2);
      users.forEach((u) => expect(u).not.toHaveProperty("password"));
    });

    it("never includes password field in any result", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "alice", group: "full", password: "topsecret", disabled: "false" },
      ]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      expect(JSON.stringify(result.structuredContent)).not.toContain("topsecret");
    });

    it("filters by group exact match", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "alice", group: "full", disabled: "false" },
        { ".id": "*2", name: "bob", group: "read", disabled: "false" },
        { ".id": "*3", name: "carol", group: "read", disabled: "false" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", group: "read" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.users as unknown[]).length).toBe(2);
    });

    it("group filter is exact match not substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "alice", group: "full", disabled: "false" },
        { ".id": "*2", name: "bob", group: "read", disabled: "false" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", group: "rea" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.users as unknown[]).length).toBe(0);
    });

    it("applies limit client-side", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "alice", group: "read" },
        { ".id": "*2", name: "bob", group: "read" },
        { ".id": "*3", name: "carol", group: "read" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", limit: 2 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.users as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });

    it("throws enriched error on failure", async () => {
      const ctx = makeContext([]);
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error"),
      );
      await expect(listTool.handler({ routerId: "test-router" }, ctx)).rejects.toThrow();
    });
  });

  describe("handler — manage_user add", () => {
    it("creates user when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "user",
        expect.objectContaining({ name: "alice", group: "read" }),
      );
    });

    it("returns already_exists when user found with same group", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when user found with different group", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "full" }]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION when group missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "alice", password: "secret123" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "USER_GROUP_REQUIRED" });
    });

    it("throws VALIDATION when password missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "add", name: "alice", group: "read" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "USER_PASSWORD_REQUIRED" });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("never includes password in structuredContent", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123", dryRun: true },
        ctx,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain("secret123");
    });

    it("never includes password in structuredContent on created action", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "add", name: "alice", group: "read", password: "secret123" },
        ctx,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain("secret123");
    });
  });

  describe("handler — manage_user remove", () => {
    it("removes user when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "alice" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("user", "*1");
    });

    it("returns not_found gracefully when user already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "alice" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "alice", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_user enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", disabled: "true" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "enable", name: "alice" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("user", "*1", { disabled: "false" });
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "alice" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("user", "*1", { disabled: "true" });
    });

    it("throws NOT_FOUND when user does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "enable", name: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", disabled: "false" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "disable", name: "alice", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_user set-password", () => {
    it("updates password for existing user", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "set-password", name: "alice", password: "newpass123" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("password_set");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("user", "*1", {
        password: "newpass123",
      });
    });

    it("throws NOT_FOUND when user does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "set-password", name: "ghost", password: "newpass" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("throws VALIDATION when password missing", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      await expect(
        manageTool.handler(
          { routerId: "test-router", action: "set-password", name: "alice" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "USER_PASSWORD_REQUIRED" });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "set-password", name: "alice", password: "newpass123", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("never includes password in dry_run structuredContent", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "set-password", name: "alice", password: "secret999", dryRun: true },
        ctx,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain("secret999");
    });

    it("never includes password in password_set result", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "alice", group: "read" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "set-password", name: "alice", password: "secret999" },
        ctx,
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain("secret999");
    });
  });
});

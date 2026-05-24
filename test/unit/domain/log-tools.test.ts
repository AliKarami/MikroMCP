import { describe, it, expect, vi } from "vitest";
import { logTools } from "../../../src/domain/tools/log-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig, Identity } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

function makeContext(
  rules: Record<string, unknown>[] = [],
  actions: Record<string, unknown>[] = [],
): ToolContext {
  const getMock = vi.fn().mockImplementation((path: string) => {
    if (path === "system/logging") return Promise.resolve(rules);
    if (path === "system/logging/action") return Promise.resolve(actions);
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
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listRulesTool, manageRuleTool, listActionsTool, manageActionTool] = logTools;

describe("logTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => expect(logTools).toHaveLength(4));
    it("has correct names", () => {
      expect(listRulesTool.name).toBe("list_log_rules");
      expect(manageRuleTool.name).toBe("manage_log_rule");
      expect(listActionsTool.name).toBe("list_log_actions");
      expect(manageActionTool.name).toBe("manage_log_action");
    });
    it("list tools are readOnly", () => {
      expect(listRulesTool.annotations.readOnlyHint).toBe(true);
      expect(listActionsTool.annotations.readOnlyHint).toBe(true);
    });
    it("manage tools are not readOnly", () => {
      expect(manageRuleTool.annotations.readOnlyHint).toBe(false);
      expect(manageActionTool.annotations.readOnlyHint).toBe(false);
    });
    it("manage tools are not destructive", () => {
      expect(manageRuleTool.annotations.destructiveHint).toBe(false);
      expect(manageActionTool.annotations.destructiveHint).toBe(false);
    });
  });

  describe("input schema — list_log_rules", () => {
    it("parses minimal input", () => {
      expect(listRulesTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true);
    });
    it("defaults limit to 100", () => {
      expect(listRulesTool.inputSchema.parse({ routerId: "r1" }).limit).toBe(100);
    });
    it("rejects extra fields", () => {
      expect(listRulesTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
  });

  describe("input schema — manage_log_rule", () => {
    it("parses valid add input", () => {
      expect(
        manageRuleTool.inputSchema.safeParse({
          routerId: "r1", action: "add", topics: "firewall", logAction: "memory",
        }).success,
      ).toBe(true);
    });
    it("dryRun defaults to false", () => {
      expect(
        manageRuleTool.inputSchema.parse({
          routerId: "r1", action: "add", topics: "firewall", logAction: "memory",
        }).dryRun,
      ).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(
        manageRuleTool.inputSchema.safeParse({
          routerId: "r1", action: "add", topics: "firewall", logAction: "memory", extra: true,
        }).success,
      ).toBe(false);
    });
    it("rejects invalid action", () => {
      expect(
        manageRuleTool.inputSchema.safeParse({
          routerId: "r1", action: "update", topics: "firewall", logAction: "memory",
        }).success,
      ).toBe(false);
    });
  });

  describe("input schema — manage_log_action", () => {
    it("parses valid add input", () => {
      expect(
        manageActionTool.inputSchema.safeParse({
          routerId: "r1", action: "add", name: "syslog-remote", type: "remote", remote: "10.0.0.1",
        }).success,
      ).toBe(true);
    });
    it("dryRun defaults to false", () => {
      expect(
        manageActionTool.inputSchema.parse({ routerId: "r1", action: "remove", name: "old-action" }).dryRun,
      ).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(
        manageActionTool.inputSchema.safeParse({
          routerId: "r1", action: "add", name: "test", type: "memory", extra: true,
        }).success,
      ).toBe(false);
    });
    it("rejects invalid type", () => {
      expect(
        manageActionTool.inputSchema.safeParse({
          routerId: "r1", action: "add", name: "test", type: "invalid",
        }).success,
      ).toBe(false);
    });
  });

  describe("handler — list_log_rules", () => {
    it("returns rules with topic filter", async () => {
      const ctx = makeContext([
        { ".id": "*1", topics: "firewall", action: "memory", disabled: "false" },
        { ".id": "*2", topics: "system", action: "disk", disabled: "false" },
      ]);
      const result = await listRulesTool.handler({ routerId: "test-router", topics: "firewall" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.rules as unknown[]).length).toBe(1);
    });

    it("returns all rules without filter", async () => {
      const ctx = makeContext([
        { ".id": "*1", topics: "firewall", action: "memory", disabled: "false" },
        { ".id": "*2", topics: "system", action: "disk", disabled: "false" },
      ]);
      const result = await listRulesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.rules as unknown[]).length).toBe(2);
    });
  });

  describe("handler — manage_log_rule add", () => {
    it("creates rule when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "add", topics: "firewall", logAction: "memory" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "system/logging",
        expect.objectContaining({ topics: "firewall", action: "memory" }),
      );
    });

    it("returns already_exists for same topics+action", async () => {
      const ctx = makeContext([{ ".id": "*1", topics: "firewall", action: "memory" }]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "add", topics: "firewall", logAction: "memory" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "add", topics: "firewall", logAction: "memory", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_log_rule enable/disable/remove", () => {
    it("disables an existing rule", async () => {
      const ctx = makeContext([{ ".id": "*1", topics: "firewall", action: "memory", disabled: "false" }]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "disable", topics: "firewall", logAction: "memory" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("system/logging", "*1", { disabled: "true" });
    });

    it("removes rule when found", async () => {
      const ctx = makeContext([{ ".id": "*1", topics: "firewall", action: "memory" }]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "remove", topics: "firewall", logAction: "memory" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("system/logging", "*1");
    });

    it("throws NOT_FOUND for disable on missing rule", async () => {
      const ctx = makeContext([]);
      await expect(
        manageRuleTool.handler(
          { routerId: "test-router", action: "disable", topics: "firewall", logAction: "memory" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("returns not_found gracefully for remove on missing rule", async () => {
      const ctx = makeContext([]);
      const result = await manageRuleTool.handler(
        { routerId: "test-router", action: "remove", topics: "firewall", logAction: "memory" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });
  });

  describe("handler — list_log_actions", () => {
    it("returns all log actions", async () => {
      const ctx = makeContext(
        [],
        [
          { ".id": "*1", name: "memory", type: "memory" },
          { ".id": "*2", name: "disk", type: "disk" },
        ],
      );
      const result = await listActionsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.actions as unknown[]).length).toBe(2);
    });
  });

  describe("handler — manage_log_action add", () => {
    it("throws VALIDATION when type missing on add", async () => {
      const ctx = makeContext([], []);
      await expect(
        manageActionTool.handler(
          { routerId: "test-router", action: "add", name: "mysyslog" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("creates action when not found", async () => {
      const ctx = makeContext([], []);
      const result = await manageActionTool.handler(
        { routerId: "test-router", action: "add", name: "mysyslog", type: "remote", remote: "10.0.0.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "system/logging/action",
        expect.objectContaining({ name: "mysyslog", type: "remote" }),
      );
    });

    it("returns already_exists for same name", async () => {
      const ctx = makeContext([], [{ ".id": "*1", name: "mysyslog", type: "remote" }]);
      const result = await manageActionTool.handler(
        { routerId: "test-router", action: "add", name: "mysyslog", type: "remote" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([], []);
      const result = await manageActionTool.handler(
        { routerId: "test-router", action: "add", name: "syslog", type: "memory", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_log_action remove", () => {
    it("removes action when found", async () => {
      const ctx = makeContext([], [{ ".id": "*1", name: "old-syslog", type: "remote" }]);
      const result = await manageActionTool.handler(
        { routerId: "test-router", action: "remove", name: "old-syslog" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("system/logging/action", "*1");
    });

    it("returns not_found gracefully when already gone", async () => {
      const ctx = makeContext([], []);
      const result = await manageActionTool.handler(
        { routerId: "test-router", action: "remove", name: "old-syslog" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });
  });
});

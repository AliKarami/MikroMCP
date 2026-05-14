import { describe, it, expect, vi } from "vitest";
import { scriptsTools } from "../../../src/domain/tools/scripts-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import { z } from "zod";

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

function makeContext(
  overrides: {
    get?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
    execute?: ReturnType<typeof vi.fn>;
  } = {},
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: { upload: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined) } as unknown as FtpClient,
    routerClient: {
      get: overrides.get ?? vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn().mockResolvedValue({ ".id": "*1", name: "my-script" }),
      update: overrides.update ?? vi.fn().mockResolvedValue(undefined),
      remove: overrides.remove ?? vi.fn().mockResolvedValue(undefined),
      execute: overrides.execute ?? vi.fn().mockResolvedValue({}),
    } as unknown as RouterOSRestClient,
  };
}

const listScriptsTool = scriptsTools[0];
const manageScriptTool = scriptsTools[1];
const runScriptTool = scriptsTools[2];

const listSchema = z.object({ routerId: z.string(), name: z.string().optional() }).strict();
const manageSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "update", "remove"]),
    name: z.string(),
    source: z.string().optional(),
    comment: z.string().optional(),
    dontRequirePermissions: z.boolean().optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();
const runSchema = z.object({ routerId: z.string(), name: z.string() }).strict();

describe("scripts tools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => {
      expect(scriptsTools).toHaveLength(3);
      expect(listScriptsTool.name).toBe("list_scripts");
      expect(manageScriptTool.name).toBe("manage_script");
      expect(runScriptTool.name).toBe("run_script");
    });

    it("list_scripts has readOnlyHint true", () => {
      expect(listScriptsTool.annotations.readOnlyHint).toBe(true);
      expect(listScriptsTool.annotations.destructiveHint).toBe(false);
    });

    it("manage_script has correct annotations", () => {
      expect(manageScriptTool.annotations.readOnlyHint).toBe(false);
      expect(manageScriptTool.annotations.idempotentHint).toBe(true);
    });

    it("run_script has idempotentHint false", () => {
      expect(runScriptTool.annotations.idempotentHint).toBe(false);
    });
  });

  describe("list_scripts input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", extra: true })).toThrow();
    });
  });

  describe("manage_script input schema", () => {
    it("accepts valid add", () => {
      const r = manageSchema.parse({
        routerId: "r",
        action: "add",
        name: "s",
        source: ":log info",
      });
      expect(r.dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({ routerId: "r", action: "add", name: "s", source: "x", extra: true }),
      ).toThrow();
    });
  });

  describe("run_script input schema", () => {
    it("accepts valid input", () => {
      expect(() => runSchema.parse({ routerId: "r", name: "my-script" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => runSchema.parse({ routerId: "r", name: "s", extra: true })).toThrow();
    });
  });

  describe("list_scripts handler", () => {
    it("returns all scripts", async () => {
      const scripts = [
        { ".id": "*1", name: "backup", source: ":log info", "run-count": "5" },
        { ".id": "*2", name: "cleanup", source: ":log warn", "run-count": "0" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(scripts) });
      const result = await listScriptsTool.handler({ routerId: "test-router" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by name substring", async () => {
      const scripts = [
        { ".id": "*1", name: "backup-daily", source: ":log info", "run-count": "1" },
        { ".id": "*2", name: "cleanup", source: ":log warn", "run-count": "0" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(scripts) });
      const result = await listScriptsTool.handler({ routerId: "test-router", name: "back" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.scripts as unknown[]).length).toBe(1);
    });
  });

  describe("manage_script handler - add", () => {
    it("creates script and returns created", async () => {
      const create = vi.fn().mockResolvedValue({ ".id": "*1", name: "my-script" });
      const ctx = makeContext({ create });
      const result = await manageScriptTool.handler(
        { routerId: "test-router", action: "add", name: "my-script", source: ":log info msg" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(create).toHaveBeenCalled();
    });

    it("throws CONFLICT when script already exists", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "my-script" }]),
      });
      await expect(
        manageScriptTool.handler(
          { routerId: "test-router", action: "add", name: "my-script", source: ":log info" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "SCRIPT_CONFLICT" });
    });

    it("returns dry_run without calling create", async () => {
      const create = vi.fn();
      const ctx = makeContext({ create });
      const result = await manageScriptTool.handler(
        { routerId: "test-router", action: "add", name: "s", source: ":log info", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(create).not.toHaveBeenCalled();
    });

    it("throws VALIDATION when source is missing on add", async () => {
      const ctx = makeContext();
      await expect(
        manageScriptTool.handler({ routerId: "test-router", action: "add", name: "s" }, ctx),
      ).rejects.toMatchObject({ code: "SOURCE_REQUIRED" });
    });
  });

  describe("manage_script handler - update", () => {
    it("updates source and returns updated", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "my-script", source: "old" }]),
        update,
      });
      const result = await manageScriptTool.handler(
        { routerId: "test-router", action: "update", name: "my-script", source: "new source" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith(
        "system/script",
        "*1",
        expect.objectContaining({ source: "new source" }),
      );
    });

    it("throws NOT_FOUND when script does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        manageScriptTool.handler(
          { routerId: "test-router", action: "update", name: "missing", source: "x" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "SCRIPT_NOT_FOUND" });
    });

    it("updates dontRequirePermissions", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "my-script", source: "x" }]),
        update,
      });
      await manageScriptTool.handler(
        {
          routerId: "test-router",
          action: "update",
          name: "my-script",
          dontRequirePermissions: true,
        },
        ctx,
      );
      expect(update).toHaveBeenCalledWith(
        "system/script",
        "*1",
        expect.objectContaining({ "dont-require-permissions": "yes" }),
      );
    });
  });

  describe("manage_script handler - remove", () => {
    it("removes existing script", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "my-script" }]),
        remove,
      });
      const result = await manageScriptTool.handler(
        { routerId: "test-router", action: "remove", name: "my-script" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(remove).toHaveBeenCalledWith("system/script", "*1");
    });

    it("returns already_removed when script not found", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      const result = await manageScriptTool.handler(
        { routerId: "test-router", action: "remove", name: "gone" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });
  });

  describe("run_script handler", () => {
    it("executes script and returns success", async () => {
      const execute = vi.fn().mockResolvedValue({});
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "my-script" }]),
        execute,
      });
      const result = await runScriptTool.handler(
        { routerId: "test-router", name: "my-script" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("executed");
      expect(execute).toHaveBeenCalledWith("system/script/run", { number: "my-script" });
    });

    it("throws NOT_FOUND when script does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        runScriptTool.handler({ routerId: "test-router", name: "missing" }, ctx),
      ).rejects.toMatchObject({ code: "SCRIPT_NOT_FOUND" });
    });
  });
});

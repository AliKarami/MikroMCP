import { describe, it, expect, vi } from "vitest";
import { schedulerTools } from "../../../src/domain/tools/scheduler-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
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
      create: overrides.create ?? vi.fn().mockResolvedValue({ ".id": "*1", name: "daily-backup" }),
      update: overrides.update ?? vi.fn().mockResolvedValue(undefined),
      remove: overrides.remove ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const listJobsTool = schedulerTools[0];
const manageJobTool = schedulerTools[1];

const listSchema = z.object({ routerId: z.string(), name: z.string().optional() }).strict();
const manageSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "update", "remove", "enable", "disable"]),
    name: z.string(),
    onEvent: z.string().optional(),
    startDate: z.string().optional(),
    startTime: z.string().optional(),
    interval: z.string().optional(),
    comment: z.string().optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

describe("scheduler tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(schedulerTools).toHaveLength(2);
      expect(listJobsTool.name).toBe("list_scheduled_jobs");
      expect(manageJobTool.name).toBe("manage_scheduled_job");
    });

    it("list_scheduled_jobs has readOnlyHint true", () => {
      expect(listJobsTool.annotations.readOnlyHint).toBe(true);
    });

    it("manage_scheduled_job has correct annotations", () => {
      expect(manageJobTool.annotations.readOnlyHint).toBe(false);
      expect(manageJobTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_scheduled_jobs input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", extra: true })).toThrow();
    });
  });

  describe("manage_scheduled_job input schema", () => {
    it("accepts valid add with defaults", () => {
      const r = manageSchema.parse({ routerId: "r", action: "add", name: "j", onEvent: "backup" });
      expect(r.dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({ routerId: "r", action: "add", name: "j", extra: true }),
      ).toThrow();
    });
  });

  describe("list_scheduled_jobs handler", () => {
    it("returns all jobs with total", async () => {
      const jobs = [
        { ".id": "*1", name: "daily-backup", "on-event": "backup", interval: "24:00:00" },
        { ".id": "*2", name: "cleanup", "on-event": "clean", interval: "01:00:00" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(jobs) });
      const result = await listJobsTool.handler({ routerId: "test-router" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by name", async () => {
      const jobs = [
        { ".id": "*1", name: "daily-backup", "on-event": "backup" },
        { ".id": "*2", name: "cleanup", "on-event": "clean" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(jobs) });
      const result = await listJobsTool.handler(
        { routerId: "test-router", name: "daily-backup" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.jobs as unknown[]).length).toBe(1);
    });
  });

  describe("manage_scheduled_job handler - add", () => {
    it("requires onEvent on add", async () => {
      const ctx = makeContext();
      await expect(
        manageJobTool.handler({ routerId: "test-router", action: "add", name: "j" }, ctx),
      ).rejects.toMatchObject({ code: "ON_EVENT_REQUIRED" });
    });

    it("throws CONFLICT if job already exists", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "daily-backup" }]),
      });
      await expect(
        manageJobTool.handler(
          { routerId: "test-router", action: "add", name: "daily-backup", onEvent: "backup" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
    });

    it("creates job and returns created", async () => {
      const create = vi.fn().mockResolvedValue({ ".id": "*1", name: "daily-backup" });
      const ctx = makeContext({ create });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "add", name: "daily-backup", onEvent: "backup" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(create).toHaveBeenCalledWith(
        "system/scheduler",
        expect.objectContaining({ name: "daily-backup", "on-event": "backup" }),
      );
    });

    it("returns dry_run without calling create", async () => {
      const create = vi.fn();
      const ctx = makeContext({ create });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "add", name: "j", onEvent: "backup", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("manage_scheduled_job handler - update", () => {
    it("throws NOT_FOUND when job not found", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        manageJobTool.handler({ routerId: "test-router", action: "update", name: "missing" }, ctx),
      ).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    });

    it("updates job fields", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "j", "on-event": "old" }]),
        update,
      });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "update", name: "j", onEvent: "new" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith(
        "system/scheduler",
        "*1",
        expect.objectContaining({ "on-event": "new" }),
      );
    });
  });

  describe("manage_scheduled_job handler - remove", () => {
    it("removes existing job", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "j" }]),
        remove,
      });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "remove", name: "j" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(remove).toHaveBeenCalledWith("system/scheduler", "*1");
    });

    it("returns already_removed when not found", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "remove", name: "gone" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });
  });

  describe("manage_scheduled_job handler - enable/disable", () => {
    it("disables an enabled job", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "j", disabled: "false" }]),
        update,
      });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "disable", name: "j" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith("system/scheduler", "*1", { disabled: "true" });
    });

    it("returns no_change when already in target state", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "j", disabled: "true" }]),
      });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "disable", name: "j" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });

    it("throws NOT_FOUND when job not found for enable/disable", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        manageJobTool.handler({ routerId: "test-router", action: "enable", name: "missing" }, ctx),
      ).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    });

    // Regression: the REST client parses records, so disabled arrives as a real
    // boolean (not the string "true"). Enabling a disabled job must update it,
    // not short-circuit to no_change.
    it("enables a job whose parsed disabled field is boolean true", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "j", disabled: true }]),
        update,
      });
      const result = await manageJobTool.handler(
        { routerId: "test-router", action: "enable", name: "j" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith("system/scheduler", "*1", { disabled: "false" });
    });
  });
});

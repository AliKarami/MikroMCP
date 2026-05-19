import { describe, it, expect, vi } from "vitest";
import { queueTools } from "../../../src/domain/tools/queue-tools.js";
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

function makeContext(queues: Record<string, unknown>[] = []): ToolContext {
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
      get: vi.fn().mockResolvedValue(queues),
      create: vi.fn().mockResolvedValue({ ".id": "*1", name: "test-queue" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listQueuesTool, manageQueueTool] = queueTools;

describe("queueTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(queueTools).toHaveLength(2));

    it("has correct tool names", () => {
      expect(listQueuesTool.name).toBe("list_queues");
      expect(manageQueueTool.name).toBe("manage_queue");
    });

    it("list_queues is readOnly", () =>
      expect(listQueuesTool.annotations.readOnlyHint).toBe(true));

    it("manage_queue is not readOnly", () =>
      expect(manageQueueTool.annotations.readOnlyHint).toBe(false));
  });

  describe("input schema — list_queues", () => {
    it("parses valid input", () => {
      const result = listQueuesTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listQueuesTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listQueuesTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      const result = listQueuesTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_queue", () => {
    it("parses valid add input", () => {
      const result = manageQueueTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "queue1",
        target: "192.168.1.0/24",
      });
      expect(result.success).toBe(true);
    });

    it("applies defaults: dryRun=false", () => {
      const result = manageQueueTool.inputSchema.parse({
        routerId: "r1",
        action: "add",
        name: "queue1",
      });
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageQueueTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "queue1",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageQueueTool.inputSchema.safeParse({
        routerId: "r1",
        action: "update",
        name: "queue1",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_queues", () => {
    it("returns queues in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "q1", target: "192.168.1.0/24" },
        { ".id": "*2", name: "q2", target: "192.168.2.0/24" },
      ]);
      const result = await listQueuesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.queues as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by target substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "q1", target: "10.0.0.0/24" },
        { ".id": "*2", name: "q2", target: "192.168.1.0/24" },
      ]);
      const result = await listQueuesTool.handler(
        { routerId: "test-router", target: "192.168" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.queues as unknown[]).length).toBe(1);
    });

    it("applies limit", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "q1", target: "10.0.0.0/24" },
        { ".id": "*2", name: "q2", target: "10.0.0.1/24" },
        { ".id": "*3", name: "q3", target: "10.0.0.2/24" },
      ]);
      const result = await listQueuesTool.handler(
        { routerId: "test-router", limit: 2 },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.queues as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });

    it("throws enriched error on failure", async () => {
      const ctx = makeContext([]);
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error"),
      );
      await expect(
        listQueuesTool.handler({ routerId: "test-router" }, ctx),
      ).rejects.toThrow();
    });
  });

  describe("handler — manage_queue add", () => {
    it("creates queue when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageQueueTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "q1",
          target: "192.168.1.0/24",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith(
        "queue/simple",
        expect.objectContaining({
          name: "q1",
          target: "192.168.1.0/24",
        }),
      );
    });

    it("returns already_exists when queue found with same target", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", target: "192.168.1.0/24" }]);
      const result = await manageQueueTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "q1",
          target: "192.168.1.0/24",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when queue found with different target", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", target: "10.0.0.0/24" }]);
      await expect(
        manageQueueTool.handler(
          {
            routerId: "test-router",
            action: "add",
            name: "q1",
            target: "192.168.1.0/24",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("throws VALIDATION error when target is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageQueueTool.handler(
          { routerId: "test-router", action: "add", name: "q1" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("throws VALIDATION error when target is missing even with dryRun=true", async () => {
      const ctx = makeContext([]);
      await expect(
        manageQueueTool.handler(
          { routerId: "test-router", action: "add", name: "q1", dryRun: true },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION });
    });

    it("dry_run returns preview without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageQueueTool.handler(
        {
          routerId: "test-router",
          action: "add",
          name: "q1",
          target: "192.168.1.0/24",
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_queue remove", () => {
    it("removes queue when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", target: "192.168.1.0/24" }]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "remove", name: "q1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("queue/simple", "*1");
    });

    it("returns not_found when queue already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "remove", name: "q1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", target: "192.168.1.0/24" }]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "remove", name: "q1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_queue enable/disable", () => {
    it("sets disabled=false on enable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", disabled: "true" }]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "enable", name: "q1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("enabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "queue/simple",
        "*1",
        { disabled: "false" },
      );
    });

    it("sets disabled=true on disable", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", disabled: "false" }]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "disable", name: "q1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("disabled");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "queue/simple",
        "*1",
        { disabled: "true" },
      );
    });

    it("throws NOT_FOUND when queue does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageQueueTool.handler(
          { routerId: "test-router", action: "enable", name: "nonexistent" },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "q1", disabled: "false" }]);
      const result = await manageQueueTool.handler(
        { routerId: "test-router", action: "disable", name: "q1", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { containerTools } from "../../../src/domain/tools/container-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
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

function makeContext(overrides: {
  get?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
} = {}): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    sshOptions: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
    routerClient: {
      get: overrides.get ?? vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn().mockResolvedValue({ ".id": "*1", name: "my-app" }),
      remove: overrides.remove ?? vi.fn().mockResolvedValue(undefined),
      execute: overrides.execute ?? vi.fn().mockResolvedValue({}),
    } as unknown as RouterOSRestClient,
  };
}

const listContainersTool = containerTools[0];
const manageContainerTool = containerTools[1];

const listSchema = z.object({ routerId: z.string() }).strict();
const manageSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["create", "start", "stop", "remove"]),
    name: z.string(),
    remoteImage: z.string().optional(),
    interface: z.string().optional(),
    rootDir: z.string().optional(),
    envlist: z.string().optional(),
    comment: z.string().optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

describe("container tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(containerTools).toHaveLength(2);
      expect(listContainersTool.name).toBe("list_containers");
      expect(manageContainerTool.name).toBe("manage_container");
    });

    it("list_containers has readOnlyHint true", () => {
      expect(listContainersTool.annotations.readOnlyHint).toBe(true);
    });

    it("manage_container has correct annotations", () => {
      expect(manageContainerTool.annotations.readOnlyHint).toBe(false);
      expect(manageContainerTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_containers input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", extra: true })).toThrow();
    });
  });

  describe("manage_container input schema", () => {
    it("accepts valid create with defaults", () => {
      const r = manageSchema.parse({
        routerId: "r",
        action: "create",
        name: "app",
        remoteImage: "alpine:latest",
        interface: "veth1",
      });
      expect(r.dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({ routerId: "r", action: "create", name: "app", extra: true }),
      ).toThrow();
    });
  });

  describe("list_containers handler", () => {
    it("returns all containers with total", async () => {
      const containers = [
        { ".id": "*1", name: "app1", tag: "alpine:latest", status: "running" },
        { ".id": "*2", name: "app2", tag: "nginx:1.25", status: "stopped" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(containers) });
      const result = await listContainersTool.handler({ routerId: "test-router" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });
  });

  describe("manage_container handler - create", () => {
    it("requires remoteImage on create", async () => {
      const ctx = makeContext();
      await expect(
        manageContainerTool.handler(
          { routerId: "test-router", action: "create", name: "app", interface: "veth1" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "REMOTE_IMAGE_REQUIRED" });
    });

    it("requires interface on create", async () => {
      const ctx = makeContext();
      await expect(
        manageContainerTool.handler(
          { routerId: "test-router", action: "create", name: "app", remoteImage: "alpine:latest" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "INTERFACE_REQUIRED" });
    });

    it("throws CONFLICT when container already exists", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app" }]),
      });
      await expect(
        manageContainerTool.handler(
          {
            routerId: "test-router",
            action: "create",
            name: "app",
            remoteImage: "alpine:latest",
            interface: "veth1",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "CONTAINER_CONFLICT" });
    });

    it("creates container and returns created", async () => {
      const create = vi.fn().mockResolvedValue({ ".id": "*1", name: "app" });
      const ctx = makeContext({ create });
      const result = await manageContainerTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "app",
          remoteImage: "alpine:latest",
          interface: "veth1",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(create).toHaveBeenCalledWith(
        "container",
        expect.objectContaining({ name: "app", "remote-image": "alpine:latest", interface: "veth1" }),
      );
    });

    it("returns dry_run without calling create", async () => {
      const create = vi.fn();
      const ctx = makeContext({ create });
      const result = await manageContainerTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "app",
          remoteImage: "alpine:latest",
          interface: "veth1",
          dryRun: true,
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("manage_container handler - start", () => {
    it("starts a stopped container", async () => {
      const execute = vi.fn().mockResolvedValue({});
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "stopped" }]),
        execute,
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "start", name: "app" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("started");
      expect(execute).toHaveBeenCalledWith("container/start", { number: "*1" });
    });

    it("returns no_change when already running", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "running" }]),
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "start", name: "app" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });

    it("throws NOT_FOUND when container does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        manageContainerTool.handler(
          { routerId: "test-router", action: "start", name: "missing" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    });
  });

  describe("manage_container handler - stop", () => {
    it("stops a running container", async () => {
      const execute = vi.fn().mockResolvedValue({});
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "running" }]),
        execute,
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "stop", name: "app" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("stopped");
      expect(execute).toHaveBeenCalledWith("container/stop", { number: "*1" });
    });

    it("returns no_change when already stopped", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "stopped" }]),
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "stop", name: "app" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });
  });

  describe("manage_container handler - remove", () => {
    it("removes an existing container", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "stopped" }]),
        remove,
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "remove", name: "app" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(remove).toHaveBeenCalledWith("container", "*1");
    });

    it("throws NOT_FOUND when container does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        manageContainerTool.handler(
          { routerId: "test-router", action: "remove", name: "missing" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    });

    it("returns dry_run without calling remove", async () => {
      const remove = vi.fn();
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "app", status: "stopped" }]),
        remove,
      });
      const result = await manageContainerTool.handler(
        { routerId: "test-router", action: "remove", name: "app", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(remove).not.toHaveBeenCalled();
    });
  });
});

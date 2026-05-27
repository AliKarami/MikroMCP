import { describe, it, expect, vi } from "vitest";
import { containerConfigTools } from "../../../src/domain/tools/container-config-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

const CONFIG = { ".id": "*1", "registry-url": "https://registry-1.docker.io", "ram-high": "128", "veth-interface": "veth1" };
const ENV1 = { ".id": "*1", name: "my-app", key: "DEBUG", value: "true" };
const MOUNT1 = { ".id": "*1", name: "app-data", src: "/mnt/data", dst: "/data" };

function makeContext(
  configRecords: Record<string, unknown>[] = [CONFIG],
  envRecords: Record<string, unknown>[] = [],
  mountRecords: Record<string, unknown>[] = [],
): ToolContext {
  const getMock = vi.fn().mockImplementation((path: string) => {
    if (path === "container/config") return Promise.resolve(configRecords);
    if (path === "container/envs") return Promise.resolve(envRecords);
    if (path === "container/mounts") return Promise.resolve(mountRecords);
    return Promise.resolve([]);
  });
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: {} as RouterConfig,
    sshClient: {} as SshClient,
    ftpClient: {} as FtpClient,
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    routerClient: {
      get: getMock,
      create: vi.fn().mockResolvedValue({ ".id": "*2" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

const [getConfigTool, manageConfigTool, listEnvsTool, manageEnvTool, listMountsTool, manageMountTool] = containerConfigTools;

describe("containerConfigTools", () => {
  describe("metadata", () => {
    it("exports 6 tools", () => expect(containerConfigTools).toHaveLength(6));
    it("has correct names", () => {
      expect(getConfigTool.name).toBe("get_container_config");
      expect(manageConfigTool.name).toBe("manage_container_config");
      expect(listEnvsTool.name).toBe("list_container_envs");
      expect(manageEnvTool.name).toBe("manage_container_env");
      expect(listMountsTool.name).toBe("list_container_mounts");
      expect(manageMountTool.name).toBe("manage_container_mount");
    });
    it("get/list tools are readOnly", () => {
      expect(getConfigTool.annotations.readOnlyHint).toBe(true);
      expect(listEnvsTool.annotations.readOnlyHint).toBe(true);
      expect(listMountsTool.annotations.readOnlyHint).toBe(true);
    });
    it("manage tools are not readOnly", () => {
      expect(manageConfigTool.annotations.readOnlyHint).toBe(false);
      expect(manageEnvTool.annotations.readOnlyHint).toBe(false);
      expect(manageMountTool.annotations.readOnlyHint).toBe(false);
    });
  });

  describe("get_container_config", () => {
    it("returns config fields", async () => {
      const ctx = makeContext();
      const result = await getConfigTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.registryUrl).toBe("https://registry-1.docker.io");
      expect(sc.ramHighMb).toBe("128");
    });
  });

  describe("manage_container_config", () => {
    it("returns no_change when nothing differs", async () => {
      const ctx = makeContext();
      const result = await manageConfigTool.handler({ routerId: "test-router", registryUrl: "https://registry-1.docker.io" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("updates changed fields", async () => {
      const ctx = makeContext();
      const result = await manageConfigTool.handler({ routerId: "test-router", registryUrl: "https://my.registry.io" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("container/config", "*1", expect.objectContaining({ "registry-url": "https://my.registry.io" }));
    });

    it("dry_run returns diff without update", async () => {
      const ctx = makeContext();
      const result = await manageConfigTool.handler({ routerId: "test-router", registryUrl: "https://my.registry.io", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("list_container_envs", () => {
    it("returns all envs without filter", async () => {
      const ctx = makeContext([], [ENV1, { ".id": "*2", name: "other-app", key: "PORT", value: "8080" }]);
      const result = await listEnvsTool.handler({ routerId: "test-router" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).envs as unknown[]).length).toBe(2);
    });

    it("filters by container name", async () => {
      const ctx = makeContext([], [ENV1, { ".id": "*2", name: "other-app", key: "PORT", value: "8080" }]);
      const result = await listEnvsTool.handler({ routerId: "test-router", name: "my-app" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).envs as unknown[]).length).toBe(1);
    });
  });

  describe("manage_container_env", () => {
    it("creates env when not found", async () => {
      const ctx = makeContext([], []);
      const result = await manageEnvTool.handler({ routerId: "test-router", action: "add", name: "my-app", key: "DEBUG", value: "true" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
    });

    it("returns already_exists with same value", async () => {
      const ctx = makeContext([], [ENV1]);
      const result = await manageEnvTool.handler({ routerId: "test-router", action: "add", name: "my-app", key: "DEBUG", value: "true" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT with different value", async () => {
      const ctx = makeContext([], [ENV1]);
      await expect(
        manageEnvTool.handler({ routerId: "test-router", action: "add", name: "my-app", key: "DEBUG", value: "false" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("removes env when found", async () => {
      const ctx = makeContext([], [ENV1]);
      const result = await manageEnvTool.handler({ routerId: "test-router", action: "remove", name: "my-app", key: "DEBUG" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("container/envs", "*1");
    });

    it("returns not_found gracefully on remove when missing", async () => {
      const ctx = makeContext([], []);
      const result = await manageEnvTool.handler({ routerId: "test-router", action: "remove", name: "my-app", key: "DEBUG" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeContext([], []);
      const result = await manageEnvTool.handler({ routerId: "test-router", action: "add", name: "my-app", key: "DEBUG", value: "true", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("list_container_mounts", () => {
    it("returns all mounts", async () => {
      const ctx = makeContext([], [], [MOUNT1]);
      const result = await listMountsTool.handler({ routerId: "test-router" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).mounts as unknown[]).length).toBe(1);
    });
  });

  describe("manage_container_mount", () => {
    it("creates mount when not found", async () => {
      const ctx = makeContext([], [], []);
      const result = await manageMountTool.handler({ routerId: "test-router", action: "add", name: "app-data", src: "/mnt/data", dst: "/data" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
    });

    it("returns already_exists when mount matches src+dst", async () => {
      const ctx = makeContext([], [], [MOUNT1]);
      const result = await manageMountTool.handler({ routerId: "test-router", action: "add", name: "app-data", src: "/mnt/data", dst: "/data" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("throws CONFLICT when name exists with different paths", async () => {
      const ctx = makeContext([], [], [MOUNT1]);
      await expect(
        manageMountTool.handler({ routerId: "test-router", action: "add", name: "app-data", src: "/other", dst: "/data" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT });
    });

    it("removes mount when found", async () => {
      const ctx = makeContext([], [], [MOUNT1]);
      const result = await manageMountTool.handler({ routerId: "test-router", action: "remove", name: "app-data" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("container/mounts", "*1");
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeContext([], [], []);
      const result = await manageMountTool.handler({ routerId: "test-router", action: "add", name: "app-data", src: "/mnt/data", dst: "/data", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });
});

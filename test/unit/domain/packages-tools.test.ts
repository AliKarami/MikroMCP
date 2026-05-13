import { describe, it, expect, vi } from "vitest";
import { packagesTools } from "../../../src/domain/tools/packages-tools.js";
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
  update?: ReturnType<typeof vi.fn>;
} = {}): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    sshOptions: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
    routerClient: {
      get: overrides.get ?? vi.fn().mockResolvedValue([]),
      update: overrides.update ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const listPackagesTool = packagesTools[0];
const managePackageTool = packagesTools[1];

const listSchema = z.object({ routerId: z.string(), name: z.string().optional() }).strict();
const manageSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["enable", "disable"]),
    name: z.string(),
    dryRun: z.boolean().default(false),
  })
  .strict();

describe("packages tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(packagesTools).toHaveLength(2);
      expect(listPackagesTool.name).toBe("list_packages");
      expect(managePackageTool.name).toBe("manage_package");
    });

    it("list_packages has readOnlyHint true", () => {
      expect(listPackagesTool.annotations.readOnlyHint).toBe(true);
    });

    it("manage_package has correct annotations", () => {
      expect(managePackageTool.annotations.readOnlyHint).toBe(false);
      expect(managePackageTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_packages input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", extra: true })).toThrow();
    });
  });

  describe("manage_package input schema", () => {
    it("accepts valid enable", () => {
      const r = manageSchema.parse({ routerId: "r", action: "enable", name: "wifi" });
      expect(r.dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({ routerId: "r", action: "enable", name: "wifi", extra: true }),
      ).toThrow();
    });
    it("rejects invalid action", () => {
      expect(() => manageSchema.parse({ routerId: "r", action: "add", name: "wifi" })).toThrow();
    });
  });

  describe("list_packages handler", () => {
    it("returns all packages", async () => {
      const pkgs = [
        { ".id": "*1", name: "routeros", version: "7.14", disabled: "false" },
        { ".id": "*2", name: "wifi", version: "7.14", disabled: "true" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(pkgs) });
      const result = await listPackagesTool.handler({ routerId: "test-router" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by name", async () => {
      const pkgs = [
        { ".id": "*1", name: "routeros", version: "7.14", disabled: "false" },
        { ".id": "*2", name: "wifi", version: "7.14", disabled: "false" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(pkgs) });
      const result = await listPackagesTool.handler(
        { routerId: "test-router", name: "wifi" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.packages as unknown[]).length).toBe(1);
    });
  });

  describe("manage_package handler - enable", () => {
    it("enables a disabled package", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "wifi", disabled: "true" }]),
        update,
      });
      const result = await managePackageTool.handler(
        { routerId: "test-router", action: "enable", name: "wifi" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith("system/package", "*1", { disabled: "false" });
    });

    it("returns no_change when already enabled", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "wifi", disabled: "false" }]),
      });
      const result = await managePackageTool.handler(
        { routerId: "test-router", action: "enable", name: "wifi" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });

    it("throws NOT_FOUND when package does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        managePackageTool.handler(
          { routerId: "test-router", action: "enable", name: "missing" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "PACKAGE_NOT_FOUND" });
    });

    it("returns dry_run without calling update", async () => {
      const update = vi.fn();
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "wifi", disabled: "true" }]),
        update,
      });
      const result = await managePackageTool.handler(
        { routerId: "test-router", action: "enable", name: "wifi", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("manage_package handler - disable", () => {
    it("disables an enabled package", async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "wifi", disabled: "false" }]),
        update,
      });
      const result = await managePackageTool.handler(
        { routerId: "test-router", action: "disable", name: "wifi" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(update).toHaveBeenCalledWith("system/package", "*1", { disabled: "true" });
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { pppTools } from "../../../src/domain/tools/ppp-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

const PROFILE1 = {
  ".id": "*1",
  name: "broadband",
  "local-address": "10.0.0.1",
  "remote-address": "ppp-pool",
  "dns-server": "8.8.8.8",
  "rate-limit": "10M/10M",
  "session-timeout": "1h",
  comment: "Broadband plan",
};

function makeContext(profiles: Record<string, unknown>[] = []) {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: {} as RouterConfig,
    sshClient: {} as SshClient,
    ftpClient: {} as FtpClient,
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    routerClient: {
      get: vi.fn().mockResolvedValue(profiles),
      create: vi.fn().mockResolvedValue({ ".id": "*2", name: "broadband" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

const [listTool, manageTool] = pppTools;

describe("pppTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(pppTools).toHaveLength(2));
    it("has correct names", () => {
      expect(listTool.name).toBe("list_ppp_profiles");
      expect(manageTool.name).toBe("manage_ppp_profile");
    });
    it("list_ppp_profiles is readOnly", () => expect(listTool.annotations.readOnlyHint).toBe(true));
    it("manage_ppp_profile is not readOnly", () => expect(manageTool.annotations.readOnlyHint).toBe(false));
    it("manage_ppp_profile is not destructive", () => expect(manageTool.annotations.destructiveHint).toBe(false));
  });

  describe("list_ppp_profiles input schema", () => {
    it("parses valid input", () => expect(listTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(true));
    it("applies default limit 100", () => expect(listTool.inputSchema.parse({ routerId: "r1" }).limit).toBe(100));
    it("rejects extra fields", () => expect(listTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false));
  });

  describe("manage_ppp_profile input schema", () => {
    it("parses valid add input", () => {
      expect(manageTool.inputSchema.safeParse({ routerId: "r1", action: "add", name: "basic" }).success).toBe(true);
    });
    it("dryRun defaults false", () => {
      expect(manageTool.inputSchema.parse({ routerId: "r1", action: "add", name: "basic" }).dryRun).toBe(false);
    });
    it("rejects invalid action", () => {
      expect(manageTool.inputSchema.safeParse({ routerId: "r1", action: "enable", name: "basic" }).success).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(manageTool.inputSchema.safeParse({ routerId: "r1", action: "add", name: "basic", extra: true }).success).toBe(false);
    });
  });

  describe("handler — list_ppp_profiles", () => {
    it("returns all profiles", async () => {
      const ctx = makeContext([PROFILE1, { ".id": "*2", name: "default", "local-address": "", "remote-address": "" }]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.profiles as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by exact name", async () => {
      const ctx = makeContext([PROFILE1, { ".id": "*2", name: "default", "local-address": "", "remote-address": "" }]);
      const result = await listTool.handler({ routerId: "test-router", name: "broadband" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).profiles as unknown[]).length).toBe(1);
    });
  });

  describe("handler — manage_ppp_profile add", () => {
    it("creates profile when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler({ routerId: "test-router", action: "add", name: "broadband" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("ppp/profile", expect.objectContaining({ name: "broadband" }));
    });

    it("returns already_exists when profile found", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "add", name: "broadband" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler({ routerId: "test-router", action: "add", name: "broadband", rateLimit: "10M/10M", dryRun: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      const diff = sc.diff as Array<{ property: string; before: null; after: string }>;
      expect(diff.some((d) => d.property === "name")).toBe(true);
      expect(diff.some((d) => d.property === "rate-limit" && d.after === "10M/10M")).toBe(true);
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_ppp_profile update", () => {
    it("updates profile when found", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "update", name: "broadband", rateLimit: "20M/20M" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("ppp/profile", "*1", expect.objectContaining({ "rate-limit": "20M/20M" }));
    });

    it("returns no_change when all requested values match", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "update", name: "broadband", rateLimit: "10M/10M" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when profile does not exist", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "update", name: "missing" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without update", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "update", name: "broadband", rateLimit: "20M/20M", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("dry_run returns diff without updating", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "update", name: "broadband", rateLimit: "20M/20M", dryRun: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      const diff = sc.diff as Array<{ property: string; before: string; after: string }>;
      expect(diff.some((d) => d.property === "rate-limit" && d.before === "10M/10M" && d.after === "20M/20M")).toBe(true);
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_ppp_profile remove", () => {
    it("removes profile when found", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "remove", name: "broadband" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("ppp/profile", "*1");
    });

    it("returns not_found gracefully when already gone", async () => {
      const ctx = makeContext([]);
      const result = await manageTool.handler({ routerId: "test-router", action: "remove", name: "broadband" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });

    it("dry_run returns preview without remove", async () => {
      const ctx = makeContext([PROFILE1]);
      const result = await manageTool.handler({ routerId: "test-router", action: "remove", name: "broadband", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { interfaceListTools } from "../../../src/domain/tools/interface-list-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";

const LIST1 = { ".id": "*1", name: "WAN", comment: "WAN interfaces" };
const MEMBER1 = { ".id": "*A", list: "WAN", interface: "ether1", comment: "" };

function makeContext(
  lists: Record<string, unknown>[] = [],
  members: Record<string, unknown>[] = [],
): ToolContext {
  const getMock = vi.fn().mockImplementation((path: string) => {
    if (path === "interface/list") return Promise.resolve(lists);
    if (path === "interface/list/member") return Promise.resolve(members);
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

const [listListsTool, manageListTool, manageMemberTool] = interfaceListTools;

describe("interfaceListTools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => expect(interfaceListTools).toHaveLength(3));
    it("has correct names", () => {
      expect(listListsTool.name).toBe("list_interface_lists");
      expect(manageListTool.name).toBe("manage_interface_list");
      expect(manageMemberTool.name).toBe("manage_interface_list_member");
    });
    it("list_interface_lists is readOnly", () => expect(listListsTool.annotations.readOnlyHint).toBe(true));
    it("manage tools are not readOnly", () => {
      expect(manageListTool.annotations.readOnlyHint).toBe(false);
      expect(manageMemberTool.annotations.readOnlyHint).toBe(false);
    });
    it("none are destructive", () => {
      expect(manageListTool.annotations.destructiveHint).toBe(false);
      expect(manageMemberTool.annotations.destructiveHint).toBe(false);
    });
  });

  describe("list_interface_lists", () => {
    it("returns all lists", async () => {
      const ctx = makeContext([LIST1, { ".id": "*2", name: "LAN", comment: "" }]);
      const result = await listListsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.lists as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("applies default limit 100", () => {
      expect(listListsTool.inputSchema.parse({ routerId: "r1" }).limit).toBe(100);
    });

    it("rejects extra fields", () => {
      expect(listListsTool.inputSchema.safeParse({ routerId: "r1", extra: true }).success).toBe(false);
    });
  });

  describe("manage_interface_list", () => {
    it("creates list when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageListTool.handler({ routerId: "test-router", action: "add", name: "WAN" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/list", expect.objectContaining({ name: "WAN" }));
    });

    it("returns already_exists when list found", async () => {
      const ctx = makeContext([LIST1]);
      const result = await manageListTool.handler({ routerId: "test-router", action: "add", name: "WAN" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("removes list when found", async () => {
      const ctx = makeContext([LIST1]);
      const result = await manageListTool.handler({ routerId: "test-router", action: "remove", name: "WAN" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/list", "*1");
    });

    it("returns not_found gracefully on remove when missing", async () => {
      const ctx = makeContext([]);
      const result = await manageListTool.handler({ routerId: "test-router", action: "remove", name: "WAN" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeContext([]);
      const result = await manageListTool.handler({ routerId: "test-router", action: "add", name: "WAN", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("rejects invalid action", () => {
      expect(manageListTool.inputSchema.safeParse({ routerId: "r1", action: "enable", name: "WAN" }).success).toBe(false);
    });
  });

  describe("manage_interface_list_member", () => {
    it("adds member when not found", async () => {
      const ctx = makeContext([], []);
      const result = await manageMemberTool.handler({ routerId: "test-router", action: "add", list: "WAN", interface: "ether1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/list/member", expect.objectContaining({ list: "WAN", interface: "ether1" }));
    });

    it("returns already_exists when member found", async () => {
      const ctx = makeContext([], [MEMBER1]);
      const result = await manageMemberTool.handler({ routerId: "test-router", action: "add", list: "WAN", interface: "ether1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("removes member when found", async () => {
      const ctx = makeContext([], [MEMBER1]);
      const result = await manageMemberTool.handler({ routerId: "test-router", action: "remove", list: "WAN", interface: "ether1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/list/member", "*A");
    });

    it("returns not_found gracefully on remove when missing", async () => {
      const ctx = makeContext([], []);
      const result = await manageMemberTool.handler({ routerId: "test-router", action: "remove", list: "WAN", interface: "ether1" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
    });

    it("dry_run returns preview without create", async () => {
      const ctx = makeContext([], []);
      const result = await manageMemberTool.handler({ routerId: "test-router", action: "add", list: "WAN", interface: "ether1", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("rejects extra fields", () => {
      expect(manageMemberTool.inputSchema.safeParse({ routerId: "r1", action: "add", list: "WAN", interface: "ether1", extra: true }).success).toBe(false);
    });
  });
});

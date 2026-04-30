import { describe, it, expect, vi } from "vitest";
import { addressListTools } from "../../../src/domain/tools/address-list-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const listAddressListTool = addressListTools[0];
const manageAddressListTool = addressListTools[1];

const listSchema = z.object({
  routerId: z.string(),
  list: z.string().optional(),
  address: z.string().optional(),
}).strict();

const manageSchema = z.object({
  routerId: z.string(),
  action: z.enum(["add", "remove"]),
  list: z.string(),
  address: z.string(),
  comment: z.string().optional(),
  timeout: z.string().optional(),
  dryRun: z.boolean().default(false),
}).strict();

function makeContext(
  records: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue(createReturn ?? { ".id": "*1", list: "blocked", address: "10.0.0.1" }),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

describe("address list tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(addressListTools).toHaveLength(2);
      expect(listAddressListTool.name).toBe("list_address_list_entries");
      expect(manageAddressListTool.name).toBe("manage_address_list_entry");
    });

    it("list_address_list_entries has readOnlyHint true", () => {
      expect(listAddressListTool.annotations.readOnlyHint).toBe(true);
      expect(listAddressListTool.annotations.destructiveHint).toBe(false);
    });

    it("manage_address_list_entry has correct annotations", () => {
      expect(manageAddressListTool.annotations.readOnlyHint).toBe(false);
      expect(manageAddressListTool.annotations.destructiveHint).toBe(false);
      expect(manageAddressListTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_address_list_entries input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("manage_address_list_entry input schema", () => {
    it("accepts valid add", () => {
      const r = manageSchema.parse({ routerId: "r", action: "add", list: "blocked", address: "10.0.0.1" });
      expect(r.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({ routerId: "r", action: "add", list: "l", address: "1.1.1.1", extra: true }),
      ).toThrow();
    });
  });

  describe("list_address_list_entries handler", () => {
    it("returns all entries with correct total", async () => {
      const entries = [
        { ".id": "*1", list: "blocked", address: "10.0.0.1" },
        { ".id": "*2", list: "allowed", address: "192.168.1.0/24" },
      ];
      const ctx = makeContext(entries);
      const result = await listAddressListTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
    });
  });

  describe("manage_address_list_entry handler - add", () => {
    it("creates entry and returns created", async () => {
      const ctx = makeContext([]);
      const result = await manageAddressListTool.handler(
        { routerId: "test-router", action: "add", list: "blocked", address: "10.0.0.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
      expect(mockCreate).toHaveBeenCalled();
    });

    it("returns already_exists when list+address found", async () => {
      const existing = { ".id": "*1", list: "blocked", address: "10.0.0.1" };
      const ctx = makeContext([existing]);
      const result = await manageAddressListTool.handler(
        { routerId: "test-router", action: "add", list: "blocked", address: "10.0.0.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageAddressListTool.handler(
        { routerId: "test-router", action: "add", list: "blocked", address: "10.0.0.1", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("manage_address_list_entry handler - remove", () => {
    it("removes entry and calls remove with correct args", async () => {
      const existing = { ".id": "*1", list: "blocked", address: "10.0.0.1" };
      const ctx = makeContext([existing]);
      const result = await manageAddressListTool.handler(
        { routerId: "test-router", action: "remove", list: "blocked", address: "10.0.0.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<typeof vi.fn>;
      expect(mockRemove).toHaveBeenCalledWith("ip/firewall/address-list", "*1");
    });

    it("returns already_removed when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageAddressListTool.handler(
        { routerId: "test-router", action: "remove", list: "blocked", address: "10.0.0.1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });
  });
});

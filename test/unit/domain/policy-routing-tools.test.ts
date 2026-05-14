import { describe, it, expect, vi } from "vitest";
import { policyRoutingTools } from "../../../src/domain/tools/policy-routing-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const listRoutingRulesTool = policyRoutingTools[0];
const manageRoutingRuleTool = policyRoutingTools[1];
const listRoutingTablesTool = policyRoutingTools[2];
const manageRoutingTableTool = policyRoutingTools[3];

const listRulesSchema = z
  .object({
    routerId: z.string(),
    table: z.string().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

const manageRuleSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "remove", "enable", "disable"]),
    table: z.string(),
    srcAddress: z.string().optional(),
    dstAddress: z.string().optional(),
    interface: z.string().optional(),
    priority: z.number().int().min(0).max(4294967295).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

const manageTableSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "remove"]),
    name: z.string(),
    fib: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();

function makeContext(
  records: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      create: vi.fn().mockResolvedValue(createReturn ?? { ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

describe("policy routing tools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => {
      expect(policyRoutingTools).toHaveLength(4);
      expect(listRoutingRulesTool.name).toBe("list_routing_rules");
      expect(manageRoutingRuleTool.name).toBe("manage_routing_rule");
      expect(listRoutingTablesTool.name).toBe("list_routing_tables");
      expect(manageRoutingTableTool.name).toBe("manage_routing_table");
    });

    it("list tools have readOnlyHint true", () => {
      expect(listRoutingRulesTool.annotations.readOnlyHint).toBe(true);
      expect(listRoutingTablesTool.annotations.readOnlyHint).toBe(true);
    });

    it("manage tools have readOnlyHint false and idempotentHint true", () => {
      expect(manageRoutingRuleTool.annotations.readOnlyHint).toBe(false);
      expect(manageRoutingRuleTool.annotations.idempotentHint).toBe(true);
      expect(manageRoutingTableTool.annotations.readOnlyHint).toBe(false);
      expect(manageRoutingTableTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("manage_routing_rule input schema", () => {
    it("accepts valid add with dstAddress and table", () => {
      const r = manageRuleSchema.parse({
        routerId: "r",
        action: "add",
        table: "isp1",
        dstAddress: "0.0.0.0/0",
      });
      expect(r.dryRun).toBe(false);
    });

    it("rejects priority below 0", () => {
      expect(() =>
        manageRuleSchema.parse({
          routerId: "r",
          action: "add",
          table: "t",
          dstAddress: "0.0.0.0/0",
          priority: -1,
        }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageRuleSchema.parse({
          routerId: "r",
          action: "add",
          table: "t",
          dstAddress: "0.0.0.0/0",
          unknownField: true,
        }),
      ).toThrow();
    });
  });

  describe("manage_routing_table input schema", () => {
    it("accepts valid add", () => {
      const r = manageTableSchema.parse({ routerId: "r", action: "add", name: "isp1" });
      expect(r.fib).toBe(false);
      expect(r.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageTableSchema.parse({ routerId: "r", action: "add", name: "isp1", unknownField: true }),
      ).toThrow();
    });
  });

  describe("list_routing_rules handler", () => {
    const sampleRules = [
      {
        ".id": "*1",
        "dst-address": "0.0.0.0/0",
        table: "isp1",
        "src-address": "",
        interface: "",
        disabled: "false",
      },
      {
        ".id": "*2",
        "src-address": "192.168.1.0/24",
        table: "isp2",
        "dst-address": "",
        interface: "",
        disabled: "true",
      },
    ];

    it("returns all rules with correct total", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listRoutingRulesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
    });

    it("filters by table", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listRoutingRulesTool.handler(
        { routerId: "test-router", table: "isp1" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
    });

    it("filters by disabled", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listRoutingRulesTool.handler(
        { routerId: "test-router", disabled: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
    });
  });

  describe("manage_routing_rule handler - add", () => {
    it("creates rule and returns created", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingRuleTool.handler(
        { routerId: "test-router", action: "add", table: "isp1", dstAddress: "0.0.0.0/0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).toHaveBeenCalled();
    });

    it("returns already_exists when composite key matches", async () => {
      const existing = {
        ".id": "*1",
        table: "isp1",
        "dst-address": "0.0.0.0/0",
        "src-address": "",
        interface: "",
        disabled: "false",
      };
      const ctx = makeContext([existing]);
      const result = await manageRoutingRuleTool.handler(
        { routerId: "test-router", action: "add", table: "isp1", dstAddress: "0.0.0.0/0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          table: "isp1",
          dstAddress: "0.0.0.0/0",
          dryRun: true,
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("manage_routing_rule handler - remove", () => {
    it("removes rule and returns removed", async () => {
      const existing = {
        ".id": "*1",
        table: "isp1",
        "dst-address": "0.0.0.0/0",
        "src-address": "",
        interface: "",
        disabled: "false",
      };
      const ctx = makeContext([existing]);
      const result = await manageRoutingRuleTool.handler(
        { routerId: "test-router", action: "remove", table: "isp1", dstAddress: "0.0.0.0/0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<
        typeof vi.fn
      >;
      expect(mockRemove).toHaveBeenCalledWith("routing/rule", "*1");
    });

    it("returns already_removed when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingRuleTool.handler(
        { routerId: "test-router", action: "remove", table: "isp1", dstAddress: "0.0.0.0/0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });
  });

  describe("manage_routing_rule handler - enable/disable", () => {
    it("throws NOT_FOUND when rule not found", async () => {
      const ctx = makeContext([]);
      await expect(
        manageRoutingRuleTool.handler(
          { routerId: "test-router", action: "enable", table: "isp1", dstAddress: "0.0.0.0/0" },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("calls update with disabled true when disabling", async () => {
      const existing = {
        ".id": "*1",
        table: "isp1",
        "dst-address": "0.0.0.0/0",
        "src-address": "",
        interface: "",
        disabled: "false",
      };
      const ctx = makeContext([existing]);
      const result = await manageRoutingRuleTool.handler(
        { routerId: "test-router", action: "disable", table: "isp1", dstAddress: "0.0.0.0/0" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).toHaveBeenCalledWith("routing/rule", "*1", { disabled: "true" });
    });
  });

  describe("manage_routing_table handler", () => {
    it("creates table and returns created", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingTableTool.handler(
        { routerId: "test-router", action: "add", name: "isp1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
    });

    it("returns already_exists when name found", async () => {
      const existing = { ".id": "*1", name: "isp1" };
      const ctx = makeContext([existing]);
      const result = await manageRoutingTableTool.handler(
        { routerId: "test-router", action: "add", name: "isp1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("removes table and calls remove with correct args", async () => {
      const existing = { ".id": "*1", name: "isp1" };
      const ctx = makeContext([existing]);
      const result = await manageRoutingTableTool.handler(
        { routerId: "test-router", action: "remove", name: "isp1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<
        typeof vi.fn
      >;
      expect(mockRemove).toHaveBeenCalledWith("routing/table", "*1");
    });

    it("returns already_removed when not found", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingTableTool.handler(
        { routerId: "test-router", action: "remove", name: "isp1" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });

    it("returns dry_run without calling create", async () => {
      const ctx = makeContext([]);
      const result = await manageRoutingTableTool.handler(
        { routerId: "test-router", action: "add", name: "isp1", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});

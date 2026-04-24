import { describe, it, expect, vi } from "vitest";
import { firewallTools } from "../../../src/domain/tools/firewall-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const listFirewallRulesTool = firewallTools[0];
const manageFirewallRuleTool = firewallTools[1];

const listFirewallRulesInputSchema = z.object({
  routerId: z.string(),
  table: z.enum(["filter", "nat"]).default("filter"),
  chain: z.string().optional(),
  disabled: z.enum(["true", "false", "all"]).default("all"),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

const manageFirewallRuleInputSchema = z.object({
  routerId: z.string(),
  table: z.enum(["filter", "nat"]).default("filter"),
  action: z.enum(["add", "remove", "disable", "enable"]),
  chain: z.string(),
  ruleAction: z.string(),
  srcAddress: z.string().optional(),
  dstAddress: z.string().optional(),
  protocol: z.enum(["tcp", "udp", "icmp", "gre", "ospf", "all"]).optional(),
  srcPort: z.string().optional(),
  dstPort: z.string().optional(),
  inInterface: z.string().optional(),
  outInterface: z.string().optional(),
  comment: z.string().max(255).optional(),
  disabled: z.boolean().default(false),
  placeBefore: z.string().optional(),
  dryRun: z.boolean().default(false),
}).strict();

function makeContext(
  records: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(records);
  const mockCreate = vi.fn().mockResolvedValue(
    createReturn ?? { ".id": "*1", chain: "forward", action: "drop" },
  );
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  const mockUpdate = vi.fn().mockResolvedValue(undefined);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: { get: mockGet, create: mockCreate, remove: mockRemove, update: mockUpdate } as unknown as RouterOSRestClient,
  };
}

describe("firewall tools", () => {
  describe("metadata", () => {
    it("exports 2 tools: list_firewall_rules and manage_firewall_rule", () => {
      expect(firewallTools).toHaveLength(2);
      expect(listFirewallRulesTool.name).toBe("list_firewall_rules");
      expect(manageFirewallRuleTool.name).toBe("manage_firewall_rule");
    });

    it("list_firewall_rules has correct annotations", () => {
      expect(listFirewallRulesTool.annotations.readOnlyHint).toBe(true);
      expect(listFirewallRulesTool.annotations.destructiveHint).toBe(false);
      expect(listFirewallRulesTool.annotations.idempotentHint).toBe(true);
      expect(listFirewallRulesTool.annotations.openWorldHint).toBe(false);
    });

    it("manage_firewall_rule has correct annotations", () => {
      expect(manageFirewallRuleTool.annotations.readOnlyHint).toBe(false);
      expect(manageFirewallRuleTool.annotations.destructiveHint).toBe(true);
      expect(manageFirewallRuleTool.annotations.idempotentHint).toBe(true);
      expect(manageFirewallRuleTool.annotations.openWorldHint).toBe(false);
    });
  });

  describe("list_firewall_rules input schema", () => {
    it("accepts minimal input with correct defaults", () => {
      const r = listFirewallRulesInputSchema.parse({ routerId: "core-01" });
      expect(r.table).toBe("filter");
      expect(r.disabled).toBe("all");
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });

    it("accepts table nat and chain srcnat", () => {
      const r = listFirewallRulesInputSchema.parse({ routerId: "r", table: "nat", chain: "srcnat" });
      expect(r.table).toBe("nat");
      expect(r.chain).toBe("srcnat");
    });

    it("rejects table mangle", () => {
      expect(() => listFirewallRulesInputSchema.parse({ routerId: "r", table: "mangle" })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listFirewallRulesInputSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("manage_firewall_rule input schema", () => {
    it("accepts valid add for filter with chain forward and ruleAction drop", () => {
      const r = manageFirewallRuleInputSchema.parse({
        routerId: "r",
        action: "add",
        chain: "forward",
        ruleAction: "drop",
      });
      expect(r.action).toBe("add");
      expect(r.table).toBe("filter");
      expect(r.chain).toBe("forward");
      expect(r.ruleAction).toBe("drop");
      expect(r.disabled).toBe(false);
      expect(r.dryRun).toBe(false);
    });

    it("accepts valid add for nat with table nat, chain srcnat, ruleAction masquerade", () => {
      const r = manageFirewallRuleInputSchema.parse({
        routerId: "r",
        action: "add",
        table: "nat",
        chain: "srcnat",
        ruleAction: "masquerade",
      });
      expect(r.table).toBe("nat");
      expect(r.chain).toBe("srcnat");
      expect(r.ruleAction).toBe("masquerade");
    });

    it("rejects action update", () => {
      expect(() => manageFirewallRuleInputSchema.parse({
        routerId: "r",
        action: "update" as unknown,
        chain: "forward",
        ruleAction: "drop",
      })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => manageFirewallRuleInputSchema.parse({
        routerId: "r",
        action: "add",
        chain: "forward",
        ruleAction: "drop",
        unknownField: true,
      })).toThrow();
    });
  });

  describe("list_firewall_rules handler", () => {
    const sampleRules = [
      { ".id": "*1", chain: "forward", action: "accept", protocol: "tcp", "src-address": "10.0.0.0/8", "dst-address": "192.168.1.0/24", disabled: "false", comment: "allow-internal" },
      { ".id": "*2", chain: "forward", action: "drop", disabled: "true", comment: "block-all" },
      { ".id": "*3", chain: "input", action: "accept", protocol: "icmp", disabled: "false" },
    ];

    it("returns all rules with correct total", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listFirewallRulesTool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(3);
      expect((sc.rules as unknown[]).length).toBe(3);
    });

    it("filters by chain", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listFirewallRulesTool.handler({ routerId: "test-router", chain: "input" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
      expect((sc.rules as unknown[]).length).toBe(1);
    });

    it("filters by disabled true keeps only disabled rules", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listFirewallRulesTool.handler({ routerId: "test-router", disabled: "true" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
      const rules = sc.rules as Record<string, unknown>[];
      expect(rules[0][".id"]).toBe("*2");
    });
  });

  describe("manage_firewall_rule handler - add action", () => {
    it("creates rule and calls create with correct action key", async () => {
      const ctx = makeContext([]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "drop",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0];
      expect(callArgs[1]).toHaveProperty("action", "drop");
      expect(callArgs[1]).toHaveProperty("chain", "forward");
    });

    it("returns already_exists when comment matches existing rule", async () => {
      const existingRule = { ".id": "*1", chain: "forward", action: "drop", comment: "my-rule", disabled: "false" };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "drop",
        comment: "my-rule",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns dry_run and does not call create when dryRun is true", async () => {
      const ctx = makeContext([]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "accept",
        dryRun: true,
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("manage_firewall_rule handler - remove action", () => {
    it("throws VALIDATION when no comment provided", async () => {
      const ctx = makeContext([]);
      await expect(
        manageFirewallRuleTool.handler({
          routerId: "test-router",
          action: "remove",
          chain: "forward",
          ruleAction: "drop",
        }, ctx),
      ).rejects.toThrow("Removing a firewall rule requires a comment");
    });

    it("throws NOT_FOUND when comment not found", async () => {
      const ctx = makeContext([]);
      await expect(
        manageFirewallRuleTool.handler({
          routerId: "test-router",
          action: "remove",
          chain: "forward",
          ruleAction: "drop",
          comment: "nonexistent-rule",
        }, ctx),
      ).rejects.toThrow();
    });

    it("removes rule and calls remove", async () => {
      const existingRule = { ".id": "*1", chain: "forward", action: "drop", comment: "my-rule", disabled: "false" };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "remove",
        chain: "forward",
        ruleAction: "drop",
        comment: "my-rule",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<typeof vi.fn>;
      expect(mockRemove).toHaveBeenCalledWith("ip/firewall/filter", "*1");
    });
  });

  describe("manage_firewall_rule handler - disable action", () => {
    it("returns no_change if rule is already disabled", async () => {
      const existingRule = { ".id": "*1", chain: "forward", action: "drop", comment: "block-all", disabled: "true" };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "disable",
        chain: "forward",
        ruleAction: "drop",
        comment: "block-all",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "no_change");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<typeof vi.fn>;
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("calls update with disabled true when disabling an enabled rule", async () => {
      const existingRule = { ".id": "*1", chain: "forward", action: "drop", comment: "block-all", disabled: "false" };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "disable",
        chain: "forward",
        ruleAction: "drop",
        comment: "block-all",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "disable");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<typeof vi.fn>;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/filter", "*1", { disabled: "true" });
    });
  });

  describe("manage_firewall_rule handler - enable action", () => {
    it("calls update with disabled false when enabling a disabled rule", async () => {
      const existingRule = { ".id": "*1", chain: "forward", action: "drop", comment: "block-all", disabled: "true" };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler({
        routerId: "test-router",
        action: "enable",
        chain: "forward",
        ruleAction: "drop",
        comment: "block-all",
      }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "enable");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<typeof vi.fn>;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/filter", "*1", { disabled: "false" });
    });
  });
});

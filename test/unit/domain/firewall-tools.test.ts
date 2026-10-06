import { describe, it, expect, vi } from "vitest";
import { firewallTools } from "../../../src/domain/tools/firewall-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

const listFirewallRulesTool = firewallTools[0];
const manageFirewallRuleTool = firewallTools[1];

const listFirewallRulesInputSchema = listFirewallRulesTool.inputSchema;

const manageFirewallRuleInputSchema = manageFirewallRuleTool.inputSchema;

function makeContext(records: WireRecord[], createReturn?: Record<string, unknown>): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(fromWire(records));
  const mockCreate = vi
    .fn()
    .mockResolvedValue(createReturn ?? { ".id": "*1", chain: "forward", action: "drop" });
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  const mockUpdate = vi.fn().mockResolvedValue(undefined);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: mockGet,
      create: mockCreate,
      remove: mockRemove,
      update: mockUpdate,
    } as unknown as RouterOSRestClient,
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
      const r = listFirewallRulesInputSchema.parse({
        routerId: "r",
        table: "nat",
        chain: "srcnat",
      });
      expect(r.table).toBe("nat");
      expect(r.chain).toBe("srcnat");
    });

    it("rejects table mangle", () => {
      expect(() =>
        listFirewallRulesInputSchema.parse({ routerId: "r", table: "mangle" }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        listFirewallRulesInputSchema.parse({ routerId: "r", unknownField: true }),
      ).toThrow();
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
      expect(() =>
        manageFirewallRuleInputSchema.parse({
          routerId: "r",
          action: "update" as unknown,
          chain: "forward",
          ruleAction: "drop",
        }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageFirewallRuleInputSchema.parse({
          routerId: "r",
          action: "add",
          chain: "forward",
          ruleAction: "drop",
          unknownField: true,
        }),
      ).toThrow();
    });
  });

  describe("list_firewall_rules handler", () => {
    const sampleRules = [
      {
        ".id": "*1",
        chain: "forward",
        action: "accept",
        protocol: "tcp",
        "src-address": "10.0.0.0/8",
        "dst-address": "192.168.1.0/24",
        disabled: "false",
        comment: "allow-internal",
      },
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
      const result = await listFirewallRulesTool.handler(
        { routerId: "test-router", chain: "input" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
      expect((sc.rules as unknown[]).length).toBe(1);
    });

    it("filters by disabled true keeps only disabled rules", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listFirewallRulesTool.handler(
        { routerId: "test-router", disabled: "true" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
      const rules = sc.rules as Record<string, unknown>[];
      expect(rules[0][".id"]).toBe("*2");
    });
  });

  describe("manage_firewall_rule handler - add action", () => {
    it("creates rule and calls create with correct action key", async () => {
      const ctx = makeContext([]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          chain: "forward",
          ruleAction: "drop",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0];
      expect(callArgs[1]).toHaveProperty("action", "drop");
      expect(callArgs[1]).toHaveProperty("chain", "forward");
    });

    it("returns already_exists when comment matches existing rule", async () => {
      const existingRule = {
        ".id": "*1",
        chain: "forward",
        action: "drop",
        comment: "my-rule",
        disabled: "false",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          chain: "forward",
          ruleAction: "drop",
          comment: "my-rule",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns dry_run and does not call create when dryRun is true", async () => {
      const ctx = makeContext([]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          chain: "forward",
          ruleAction: "accept",
          dryRun: true,
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("manage_firewall_rule handler - remove action", () => {
    it("throws VALIDATION when no comment provided", async () => {
      const ctx = makeContext([]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "remove",
            chain: "forward",
            ruleAction: "drop",
          },
          ctx,
        ),
      ).rejects.toThrow("Removing a firewall rule requires a comment");
    });

    it("throws NOT_FOUND when comment not found", async () => {
      const ctx = makeContext([]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "remove",
            chain: "forward",
            ruleAction: "drop",
            comment: "nonexistent-rule",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("removes rule and calls remove", async () => {
      const existingRule = {
        ".id": "*1",
        chain: "forward",
        action: "drop",
        comment: "my-rule",
        disabled: "false",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "remove",
          chain: "forward",
          ruleAction: "drop",
          comment: "my-rule",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<
        typeof vi.fn
      >;
      expect(mockRemove).toHaveBeenCalledWith("ip/firewall/filter", "*1");
    });
  });

  describe("manage_firewall_rule handler - disable action", () => {
    it("returns no_change if rule is already disabled", async () => {
      const existingRule = {
        ".id": "*1",
        chain: "forward",
        action: "drop",
        comment: "block-all",
        disabled: "true",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "disable",
          chain: "forward",
          ruleAction: "drop",
          comment: "block-all",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "no_change");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("calls update with disabled true when disabling an enabled rule", async () => {
      const existingRule = {
        ".id": "*1",
        chain: "forward",
        action: "drop",
        comment: "block-all",
        disabled: "false",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "disable",
          chain: "forward",
          ruleAction: "drop",
          comment: "block-all",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "disable");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/filter", "*1", { disabled: "true" });
    });
  });

  describe("manage_firewall_rule handler - enable action", () => {
    it("calls update with disabled false when enabling a disabled rule", async () => {
      const existingRule = {
        ".id": "*1",
        chain: "forward",
        action: "drop",
        comment: "block-all",
        disabled: "true",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "enable",
          chain: "forward",
          ruleAction: "drop",
          comment: "block-all",
        },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "enable");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/filter", "*1", { disabled: "false" });
    });
  });

  describe("manage_firewall_rule handler - CONFLICT on add", () => {
    it("throws CONFLICT when rule with same comment exists but srcPort differs", async () => {
      const existingRule = {
        ".id": "*5",
        chain: "forward",
        action: "accept",
        protocol: "tcp",
        "src-port": "80",
        comment: "allow-http",
      };
      const ctx = makeContext([existingRule]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "add",
            table: "filter",
            chain: "forward",
            ruleAction: "accept",
            protocol: "tcp",
            srcPort: "443",
            comment: "allow-http",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("throws CONFLICT when rule with same comment exists but inInterface differs", async () => {
      const existingRule = {
        ".id": "*6",
        chain: "forward",
        action: "accept",
        "in-interface": "ether1",
        comment: "allow-ether1",
      };
      const ctx = makeContext([existingRule]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "add",
            table: "filter",
            chain: "forward",
            ruleAction: "accept",
            inInterface: "ether2",
            comment: "allow-ether1",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("throws CONFLICT when rule with same comment exists but srcAddress differs", async () => {
      const existingRule = {
        ".id": "*8",
        chain: "forward",
        action: "drop",
        "src-address": "10.0.0.0/8",
        comment: "block-net",
      };
      const ctx = makeContext([existingRule]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "add",
            table: "filter",
            chain: "forward",
            ruleAction: "drop",
            srcAddress: "192.168.0.0/16",
            comment: "block-net",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("throws CONFLICT when rule with same comment exists but protocol differs", async () => {
      const existingRule = {
        ".id": "*9",
        chain: "forward",
        action: "accept",
        protocol: "tcp",
        comment: "allow-proto",
      };
      const ctx = makeContext([existingRule]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action: "add",
            table: "filter",
            chain: "forward",
            ruleAction: "accept",
            protocol: "udp",
            comment: "allow-proto",
          },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("returns already_exists when srcAddress and protocol also match", async () => {
      const existingRule = {
        ".id": "*10",
        chain: "forward",
        action: "drop",
        protocol: "tcp",
        "src-address": "10.0.0.0/8",
        comment: "block-tcp",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          table: "filter",
          chain: "forward",
          ruleAction: "drop",
          protocol: "tcp",
          srcAddress: "10.0.0.0/8",
          comment: "block-tcp",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("returns already_exists when all fields including port match", async () => {
      const existingRule = {
        ".id": "*7",
        chain: "forward",
        action: "accept",
        protocol: "tcp",
        "dst-port": "443",
        comment: "allow-https",
      };
      const ctx = makeContext([existingRule]);
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          table: "filter",
          chain: "forward",
          ruleAction: "accept",
          protocol: "tcp",
          dstPort: "443",
          comment: "allow-https",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });
  });
});

describe("manage_firewall_rule - interface lists, connection state and NAT targets", () => {
  // A dst-nat rule as RouterOS sends it; makeContext runs it through the response
  // parser, which turns the single ports into numbers.
  const portForward = {
    ".id": "*4",
    chain: "dstnat",
    action: "dst-nat",
    protocol: "tcp",
    "dst-port": "8443",
    "in-interface-list": "WAN",
    "to-addresses": "192.168.88.10",
    "to-ports": "443",
    comment: "fwd-nas-https",
  };
  const portForwardParams = {
    routerId: "test-router",
    action: "add",
    table: "nat",
    chain: "dstnat",
    ruleAction: "dst-nat",
    protocol: "tcp",
    dstPort: "8443",
    inInterfaceList: "WAN",
    toAddresses: "192.168.88.10",
    toPorts: "443",
    comment: "fwd-nas-https",
  };

  function createMock(ctx: ToolContext): ReturnType<typeof vi.fn> {
    return (ctx.routerClient as unknown as Record<string, ReturnType<typeof vi.fn>>).create;
  }

  it("sends the new fields with their RouterOS names", async () => {
    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "drop",
        inInterfaceList: "WAN",
        connectionState: "new",
        connectionNatState: "!dstnat",
        comment: "drop-wan-not-dstnat",
      },
      ctx,
    );
    expect(createMock(ctx).mock.calls[0][1]).toMatchObject({
      "in-interface-list": "WAN",
      "connection-state": "new",
      "connection-nat-state": "!dstnat",
    });
  });

  it("creates a dst-nat port forward with to-addresses and to-ports", async () => {
    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(portForwardParams, ctx);
    const [path, body] = createMock(ctx).mock.calls[0];
    expect(path).toBe("ip/firewall/nat");
    expect(body).toMatchObject({
      action: "dst-nat",
      "dst-port": "8443",
      "to-addresses": "192.168.88.10",
      "to-ports": "443",
    });
  });

  it("treats numeric ports from the router as equal to requested strings", async () => {
    const ctx = makeContext([portForward]);
    const result = await manageFirewallRuleTool.handler(portForwardParams, ctx);
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    expect(createMock(ctx)).not.toHaveBeenCalled();
  });

  it("compares connection-state as a set, ignoring order", async () => {
    const existing = {
      ".id": "*9",
      chain: "forward",
      action: "accept",
      "connection-state": "established,related,untracked",
      comment: "accept-est",
    };
    const ctx = makeContext([existing]);
    const result = await manageFirewallRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "accept",
        connectionState: "untracked,established,related",
        comment: "accept-est",
      },
      ctx,
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("throws CONFLICT with to-addresses in details when the NAT target differs", async () => {
    const ctx = makeContext([portForward]);
    await expect(
      manageFirewallRuleTool.handler({ ...portForwardParams, toAddresses: "192.168.88.20" }, ctx),
    ).rejects.toMatchObject({
      code: "FIREWALL_RULE_CONFLICT",
      details: {
        existing: { "to-addresses": "192.168.88.10" },
        requested: { "to-addresses": "192.168.88.20" },
      },
    });
  });

  it("rejects toAddresses/toPorts on the filter table before touching the router", async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          table: "filter",
          chain: "forward",
          ruleAction: "accept",
          toPorts: "443",
          dryRun: true,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NAT_TARGET_NOT_APPLICABLE" });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it("includes the new fields in the dry-run diff", async () => {
    const ctx = makeContext([]);
    const result = await manageFirewallRuleTool.handler(
      { ...portForwardParams, dryRun: true },
      ctx,
    );
    const diff = (result.structuredContent as Record<string, unknown>).diff as Array<
      Record<string, unknown>
    >;
    expect(diff).toContainEqual({ property: "to-ports", before: null, after: "443" });
    expect(diff).toContainEqual({ property: "in-interface-list", before: null, after: "WAN" });
    expect(createMock(ctx)).not.toHaveBeenCalled();
  });

  it("validates connectionNatState, connectionState and toPorts formats", () => {
    const schema = manageFirewallRuleTool.inputSchema;
    const base = { routerId: "r", action: "add", chain: "forward", ruleAction: "accept" };
    expect(() => schema.parse({ ...base, connectionNatState: "!dstnat" })).not.toThrow();
    expect(() => schema.parse({ ...base, connectionNatState: "masquerade" })).toThrow();
    expect(() => schema.parse({ ...base, connectionNatState: "dstnat,dstnat" })).toThrow();
    expect(() => schema.parse({ ...base, connectionNatState: "!srcnat,dstnat" })).not.toThrow();
    expect(() => schema.parse({ ...base, connectionState: "established,bogus" })).toThrow();
    expect(() => schema.parse({ ...base, connectionState: "" })).toThrow();
    expect(() => schema.parse({ ...base, connectionState: "!invalid" })).not.toThrow();
    expect(() => schema.parse({ ...base, toPorts: "8000-8100" })).not.toThrow();
    expect(() => schema.parse({ ...base, toPorts: "https" })).toThrow();
  });
  it("treats a /32 host address as equal to the bare address", async () => {
    const existing = {
      ".id": "*C",
      chain: "dstnat",
      action: "dst-nat",
      "dst-address": "192.168.1.1",
      "to-addresses": "192.168.1.5",
      comment: "host-32",
    };
    const ctx = makeContext([existing]);
    const result = await manageFirewallRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        table: "nat",
        chain: "dstnat",
        ruleAction: "dst-nat",
        dstAddress: "192.168.1.1/32",
        toAddresses: "192.168.1.5/32",
        comment: "host-32",
      },
      ctx,
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("compares connection-nat-state as a set", async () => {
    const existing = {
      ".id": "*D",
      chain: "forward",
      action: "accept",
      "connection-nat-state": "srcnat,dstnat",
      comment: "nat-set",
    };
    const ctx = makeContext([existing]);
    const result = await manageFirewallRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        chain: "forward",
        ruleAction: "accept",
        connectionNatState: "dstnat,srcnat",
        comment: "nat-set",
      },
      ctx,
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("matches a negated connection-state and keeps the negation in the body", async () => {
    const existing = {
      ".id": "*E",
      chain: "input",
      action: "accept",
      "connection-state": "!invalid",
      comment: "not-invalid",
    };
    const params = {
      routerId: "test-router",
      action: "add",
      chain: "input",
      ruleAction: "accept",
      connectionState: "!invalid",
      comment: "not-invalid",
    };
    const same = await manageFirewallRuleTool.handler(params, makeContext([existing]));
    expect((same.structuredContent as Record<string, unknown>).action).toBe("already_exists");

    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(params, ctx);
    expect(createMock(ctx).mock.calls[0][1]).toMatchObject({ "connection-state": "!invalid" });

    await expect(
      manageFirewallRuleTool.handler(
        { ...params, connectionState: "invalid" },
        makeContext([existing]),
      ),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });

  it("treats protocol all as no protocol match", async () => {
    const base = {
      routerId: "test-router",
      action: "add",
      chain: "forward",
      ruleAction: "accept",
      protocol: "all",
      comment: "any-proto",
    };
    const unset = { ".id": "*F", chain: "forward", action: "accept", comment: "any-proto" };
    const same = await manageFirewallRuleTool.handler(base, makeContext([unset]));
    expect((same.structuredContent as Record<string, unknown>).action).toBe("already_exists");

    await expect(
      manageFirewallRuleTool.handler(base, makeContext([{ ...unset, protocol: "tcp" }])),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });

  it("rejects NAT targets that the rule action does not accept", async () => {
    const nat = { routerId: "test-router", action: "add", table: "nat", dryRun: true };
    await expect(
      manageFirewallRuleTool.handler(
        { ...nat, chain: "srcnat", ruleAction: "masquerade", toAddresses: "203.0.113.1" },
        makeContext([]),
      ),
    ).rejects.toMatchObject({ code: "NAT_TARGET_NOT_APPLICABLE" });
    await expect(
      manageFirewallRuleTool.handler(
        { ...nat, chain: "dstnat", ruleAction: "accept", toPorts: "443" },
        makeContext([]),
      ),
    ).rejects.toMatchObject({ code: "NAT_TARGET_NOT_APPLICABLE" });
  });

  it("accepts to-ports on masquerade and redirect", async () => {
    for (const ruleAction of ["masquerade", "redirect"]) {
      const result = await manageFirewallRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          table: "nat",
          chain: ruleAction === "masquerade" ? "srcnat" : "dstnat",
          ruleAction,
          toPorts: "8080",
          dryRun: true,
        },
        makeContext([]),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
    }
  });
});

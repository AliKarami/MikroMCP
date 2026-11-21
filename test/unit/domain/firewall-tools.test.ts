import { describe, it, expect, vi } from "vitest";
import { firewallTools } from "../../../src/domain/tools/firewall-tools.js";
import { probeTiming } from "../../../src/domain/tools/auto-revert.js";

probeTiming.settleMs = 0;
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { snapshotPathsFor } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

const listFirewallRulesTool = firewallTools[0];
const manageFirewallRuleTool = firewallTools[1];

const listFirewallRulesInputSchema = listFirewallRulesTool.inputSchema;

const manageFirewallRuleInputSchema = manageFirewallRuleTool.inputSchema;

const SCHEDULER = "system/scheduler";

/**
 * A client whose firewall paths return `records`, and whose scheduler accepts the
 * auto-revert job and still lists it at disarm time (the router answered).
 */
function makeContext(records: WireRecord[], createReturn?: Record<string, unknown>): ToolContext {
  const mockGet = vi.fn((path: string) =>
    Promise.resolve(
      path === SCHEDULER
        ? [{ ".id": "*S1" }]
        : path === "system/clock"
          ? { date: "2026-11-11", time: "10:00:00" }
          : fromWire(records),
    ),
  );
  const mockCreate = vi.fn((path: string) =>
    Promise.resolve(
      path === SCHEDULER
        ? { ".id": "*S1" }
        : (createReturn ?? { ".id": "*1", chain: "forward", action: "drop" }),
    ),
  );
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
      probe: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

/** The create call that wrote the firewall rule, skipping the auto-revert job. */
function firewallCreateCall(mock: ReturnType<typeof vi.fn>): unknown[] {
  const call = mock.mock.calls.find((c) => c[0] !== SCHEDULER);
  if (!call) throw new Error("no firewall create call");
  return call;
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
      const callArgs = firewallCreateCall(mockCreate);
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
    expect(firewallCreateCall(createMock(ctx))[1]).toMatchObject({
      "in-interface-list": "WAN",
      "connection-state": "new",
      "connection-nat-state": "!dstnat",
    });
  });

  it("creates a dst-nat port forward with to-addresses and to-ports", async () => {
    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(portForwardParams, ctx);
    const [path, body] = firewallCreateCall(createMock(ctx));
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
    expect(() => schema.parse({ ...base, connectionState: "new,new" })).toThrow(/only once/);
    expect(() => schema.parse({ ...base, connectionState: "!new,related,new" })).toThrow();
    expect(() => schema.parse({ ...base, toPorts: "8000-8100" })).not.toThrow();
    expect(() => schema.parse({ ...base, toPorts: "https" })).toThrow();
  });

  it.each([
    "srcAddress",
    "dstAddress",
    "srcPort",
    "dstPort",
    "inInterface",
    "outInterface",
    "inInterfaceList",
    "outInterfaceList",
    "toAddresses",
  ])("rejects an empty %s", (field) => {
    // An empty string reached the request body as "" while the idempotency check
    // treated it as an absent field.
    const base = { routerId: "r", action: "add", table: "nat", chain: "dstnat" };
    const parsed = manageFirewallRuleTool.inputSchema.safeParse({
      ...base,
      ruleAction: "dst-nat",
      [field]: "",
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects toAddresses "" before touching the router', async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler({ ...portForwardParams, toAddresses: "" }, ctx),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
    expect(createMock(ctx)).not.toHaveBeenCalled();
  });

  it.each([
    ["1", true],
    ["65535", true],
    ["80-80", true],
    ["8000-8100", true],
    ["0", false],
    ["65536", false],
    ["99999", false],
    ["9000-80", false],
    ["0-80", false],
    ["80-65536", false],
  ])("toPorts %s is accepted: %s", (toPorts, valid) => {
    const base = { routerId: "r", action: "add", chain: "dstnat", ruleAction: "dst-nat" };
    expect(manageFirewallRuleTool.inputSchema.safeParse({ ...base, toPorts }).success).toBe(valid);
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
    expect(firewallCreateCall(createMock(ctx))[1]).toMatchObject({
      "connection-state": "!invalid",
    });

    await expect(
      manageFirewallRuleTool.handler(
        { ...params, connectionState: "invalid" },
        makeContext([existing]),
      ),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });

  it("throws CONFLICT pointing to enable when only the disabled state differs", async () => {
    // RouterOS sends disabled as a string; the parser turns it into a boolean.
    const existing = { ...portForward, disabled: "true" };
    await expect(
      manageFirewallRuleTool.handler(portForwardParams, makeContext([existing])),
    ).rejects.toMatchObject({
      code: "FIREWALL_RULE_CONFLICT",
      message: expect.stringContaining("already exists but is disabled"),
      details: { existing: { disabled: true }, requested: { disabled: false } },
      recoverability: { alternativeTools: ["manage_firewall_rule with action=enable"] },
    });
  });

  it("throws CONFLICT pointing to disable when add asks for a disabled rule", async () => {
    const existing = { ...portForward, disabled: "false" };
    const ctx = makeContext([existing]);
    await expect(
      manageFirewallRuleTool.handler({ ...portForwardParams, disabled: true }, ctx),
    ).rejects.toMatchObject({
      code: "FIREWALL_RULE_CONFLICT",
      recoverability: { alternativeTools: ["manage_firewall_rule with action=disable"] },
    });
    expect(createMock(ctx)).not.toHaveBeenCalled();
  });

  it("returns already_exists when the disabled state also matches", async () => {
    const existing = { ...portForward, disabled: "true" };
    const result = await manageFirewallRuleTool.handler(
      { ...portForwardParams, disabled: true },
      makeContext([existing]),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("suggests remove when the match differs as well as the disabled state", async () => {
    const existing = { ...portForward, disabled: "true" };
    await expect(
      manageFirewallRuleTool.handler(
        { ...portForwardParams, toAddresses: "192.168.88.20" },
        makeContext([existing]),
      ),
    ).rejects.toMatchObject({
      code: "FIREWALL_RULE_CONFLICT",
      message: expect.stringContaining("different configuration"),
      recoverability: { alternativeTools: ["manage_firewall_rule with action=remove"] },
    });
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

describe("firewall rules in a numeric custom chain", () => {
  // Derived from a real defconf rule on RB5009 (RouterOS 7.24.2, list_firewall_rules,
  // 2026-10-06) moved to a jump chain named "100", which the response parser turns into 100.
  const stored: WireRecord = {
    ".id": "*6",
    action: "accept",
    bytes: "0",
    chain: "100",
    comment: "defconf: accept in ipsec policy",
    dynamic: "false",
    invalid: "false",
    "ipsec-policy": "in,ipsec",
    packets: "0",
  };

  it("a repeated add finds the rule (already_exists)", async () => {
    const result = await manageFirewallRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        chain: "100",
        ruleAction: "accept",
        comment: "defconf: accept in ipsec policy",
      },
      makeContext([stored]),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("list_firewall_rules filters by the numeric chain", async () => {
    const result = await listFirewallRulesTool.handler(
      { routerId: "test-router", chain: "100" },
      makeContext([stored]),
    );
    expect((result.structuredContent as Record<string, unknown>).total).toBe(1);
  });
});

describe("manage_firewall_rule - empty comment", () => {
  // A `?comment=` lookup matches no rule on RouterOS (checked on 7.24.2), so an empty
  // comment cannot serve as the idempotency key.
  it("the real input schema rejects an empty comment", () => {
    const result = manageFirewallRuleTool.inputSchema.safeParse({
      routerId: "r",
      action: "add",
      chain: "forward",
      ruleAction: "accept",
      comment: "",
    });
    expect(result.success).toBe(false);
  });

  it.each(["add", "remove", "enable", "disable"])(
    "%s rejects a comment that is empty after sanitizing, before any router call",
    async (action) => {
      const ctx = makeContext([]);
      await expect(
        manageFirewallRuleTool.handler(
          {
            routerId: "test-router",
            action,
            chain: "forward",
            ruleAction: "accept",
            comment: "\x01\n\x7f",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "COMMENT_EMPTY" });
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    },
  );
});

/** makeContext plus `execute`, which the move command goes through. */
function makeMoveContext(records: WireRecord[]): ToolContext {
  const ctx = makeContext(records);
  (ctx.routerClient as unknown as Record<string, unknown>).execute = vi.fn().mockResolvedValue([]);
  return ctx;
}

function mocks(ctx: ToolContext): Record<string, ReturnType<typeof vi.fn>> {
  return ctx.routerClient as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe("firewall tools - raw table and IPv6 family", () => {
  it("list_firewall_rules defaults family to ip and accepts raw and ipv6", () => {
    expect(listFirewallRulesInputSchema.parse({})).toMatchObject({
      family: "ip",
      table: "filter",
    });
    expect(listFirewallRulesInputSchema.parse({ family: "ipv6", table: "raw" })).toMatchObject({
      family: "ipv6",
      table: "raw",
    });
    expect(() => listFirewallRulesInputSchema.parse({ family: "ip4" })).toThrow();
  });

  it.each([
    ["ip", "raw", "ip/firewall/raw"],
    ["ipv6", "filter", "ipv6/firewall/filter"],
    ["ipv6", "nat", "ipv6/firewall/nat"],
    ["ipv6", "raw", "ipv6/firewall/raw"],
  ])("list_firewall_rules reads family %s table %s from %s", async (family, table, path) => {
    const ctx = makeContext([{ ".id": "*1", chain: "prerouting", action: "notrack" }]);
    const result = await listFirewallRulesTool.handler({ family, table }, ctx);
    expect(ctx.routerClient.get).toHaveBeenCalledWith(path, expect.anything());
    expect(result.structuredContent).toMatchObject({ family, table, total: 1 });
  });

  it("manage_firewall_rule defaults family to ip", () => {
    expect(
      manageFirewallRuleInputSchema.parse({ action: "add", chain: "input", ruleAction: "drop" }),
    ).toMatchObject({ family: "ip", table: "filter" });
  });

  it("adds a notrack rule to the IPv4 raw table", async () => {
    const ctx = makeContext([]);
    const result = await manageFirewallRuleTool.handler(
      {
        action: "add",
        table: "raw",
        chain: "prerouting",
        ruleAction: "notrack",
        srcAddress: "10.0.0.0/8",
        comment: "notrack-lan",
      },
      ctx,
    );
    expect(result.structuredContent).toHaveProperty("action", "created");
    expect(firewallCreateCall(mocks(ctx).create)).toEqual([
      "ip/firewall/raw",
      expect.objectContaining({ chain: "prerouting", action: "notrack" }),
    ]);
  });

  it("adds an IPv6 input rule matching icmpv6 at ipv6/firewall/filter", async () => {
    const ctx = makeContext([]);
    const result = await manageFirewallRuleTool.handler(
      {
        action: "add",
        family: "ipv6",
        chain: "input",
        ruleAction: "accept",
        protocol: "icmpv6",
        comment: "allow-icmpv6",
      },
      ctx,
    );
    expect(firewallCreateCall(mocks(ctx).create)).toEqual([
      "ipv6/firewall/filter",
      expect.objectContaining({ protocol: "icmpv6", chain: "input" }),
    ]);
    expect(result.content).toContain("ipv6 filter");
  });

  it("rejects protocol icmp for ipv6 and icmpv6 for ip, before any router call", async () => {
    const ctx = makeContext([]);
    const base = { action: "add", chain: "input", ruleAction: "accept", dryRun: true };
    await expect(
      manageFirewallRuleTool.handler({ ...base, family: "ipv6", protocol: "icmp" }, ctx),
    ).rejects.toMatchObject({ code: "PROTOCOL_FAMILY_MISMATCH", message: /icmpv6/ });
    await expect(
      manageFirewallRuleTool.handler({ ...base, protocol: "icmpv6" }, ctx),
    ).rejects.toMatchObject({ code: "PROTOCOL_FAMILY_MISMATCH" });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it("finds an IPv6 rule by comment in the IPv6 table", async () => {
    const ctx = makeContext([
      { ".id": "*9", chain: "input", action: "drop", comment: "v6-drop", disabled: "false" },
    ]);
    await manageFirewallRuleTool.handler(
      {
        action: "disable",
        family: "ipv6",
        table: "raw",
        chain: "prerouting",
        ruleAction: "drop",
        comment: "v6-drop",
        autoRevertSeconds: 0,
      },
      ctx,
    );
    expect(ctx.routerClient.update).toHaveBeenCalledWith("ipv6/firewall/raw", "*9", {
      disabled: "true",
    });
  });

  it("snapshots only the table and family the call touches", () => {
    expect(snapshotPathsFor(manageFirewallRuleTool, {})).toEqual(["ip/firewall/filter"]);
    expect(snapshotPathsFor(manageFirewallRuleTool, { table: "nat" })).toEqual(["ip/firewall/nat"]);
    expect(snapshotPathsFor(manageFirewallRuleTool, { family: "ipv6", table: "raw" })).toEqual([
      "ipv6/firewall/raw",
    ]);
  });

  it("keeps chain and ruleAction required for add, remove, enable and disable", async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler({ action: "add", ruleAction: "drop" }, ctx),
    ).rejects.toMatchObject({ code: "PARAM_REQUIRED", details: { param: "chain" } });
    await expect(
      manageFirewallRuleTool.handler({ action: "remove", chain: "input", comment: "x" }, ctx),
    ).rejects.toMatchObject({ code: "PARAM_REQUIRED", details: { param: "ruleAction" } });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });
});

describe("manage_firewall_rule - jumpTarget and rejectWith", () => {
  const add = { action: "add", chain: "forward", autoRevertSeconds: 0 };

  it("sends jump-target with a jump rule", async () => {
    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(
      { ...add, ruleAction: "jump", jumpTarget: "wan-in", comment: "to-wan-in" },
      ctx,
    );
    expect(firewallCreateCall(mocks(ctx).create)[1]).toMatchObject({
      action: "jump",
      "jump-target": "wan-in",
    });
  });

  it("requires jumpTarget for jump and rejects it otherwise", async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler({ ...add, ruleAction: "jump" }, ctx),
    ).rejects.toMatchObject({ code: "JUMP_TARGET_REQUIRED" });
    await expect(
      manageFirewallRuleTool.handler({ ...add, ruleAction: "drop", jumpTarget: "x" }, ctx),
    ).rejects.toMatchObject({ code: "JUMP_TARGET_NOT_APPLICABLE" });
    expect(ctx.routerClient.create).not.toHaveBeenCalled();
  });

  it("sends reject-with with a reject rule", async () => {
    const ctx = makeContext([]);
    await manageFirewallRuleTool.handler(
      { ...add, ruleAction: "reject", rejectWith: "tcp-reset", protocol: "tcp" },
      ctx,
    );
    expect(firewallCreateCall(mocks(ctx).create)[1]).toMatchObject({
      action: "reject",
      "reject-with": "tcp-reset",
    });
  });

  it("rejects rejectWith on another action", async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler({ ...add, ruleAction: "drop", rejectWith: "tcp-reset" }, ctx),
    ).rejects.toMatchObject({ code: "REJECT_WITH_NOT_APPLICABLE" });
  });

  it("validates rejectWith per family", async () => {
    const ctx = makeContext([]);
    await expect(
      manageFirewallRuleTool.handler(
        { ...add, ruleAction: "reject", rejectWith: "icmp-no-route" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "REJECT_WITH_FAMILY_MISMATCH" });
    await expect(
      manageFirewallRuleTool.handler(
        { ...add, family: "ipv6", ruleAction: "reject", rejectWith: "icmp-host-prohibited" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "REJECT_WITH_FAMILY_MISMATCH" });
    await manageFirewallRuleTool.handler(
      { ...add, family: "ipv6", ruleAction: "reject", rejectWith: "icmp-no-route" },
      ctx,
    );
    expect(firewallCreateCall(mocks(ctx).create)[0]).toBe("ipv6/firewall/filter");
  });

  it("the schema rejects a reject-with value of neither family", () => {
    expect(() =>
      manageFirewallRuleInputSchema.parse({ ...add, ruleAction: "reject", rejectWith: "nope" }),
    ).toThrow();
  });

  it("compares jump-target on a repeated add", async () => {
    const stored = {
      ".id": "*3",
      chain: "forward",
      action: "jump",
      "jump-target": "wan-in",
      comment: "to-wan",
      disabled: "false",
    };
    const same = await manageFirewallRuleTool.handler(
      { ...add, ruleAction: "jump", jumpTarget: "wan-in", comment: "to-wan" },
      makeContext([stored]),
    );
    expect(same.structuredContent).toHaveProperty("action", "already_exists");
    await expect(
      manageFirewallRuleTool.handler(
        { ...add, ruleAction: "jump", jumpTarget: "lan-in", comment: "to-wan" },
        makeContext([stored]),
      ),
    ).rejects.toMatchObject({
      code: "FIREWALL_RULE_CONFLICT",
      details: { existing: { "jump-target": "wan-in" }, requested: { "jump-target": "lan-in" } },
    });
  });

  it("treats an omitted rejectWith and the family default as the same", async () => {
    const reported = {
      ".id": "*3",
      chain: "forward",
      action: "reject",
      "reject-with": "icmp-network-unreachable",
      comment: "rej",
      disabled: "false",
    };
    const { "reject-with": _default, ...omitted } = reported;

    for (const [stored, rejectWith] of [
      [reported, undefined],
      [omitted, "icmp-network-unreachable"],
      [omitted, undefined],
    ] as const) {
      const result = await manageFirewallRuleTool.handler(
        { ...add, ruleAction: "reject", comment: "rej", rejectWith },
        makeContext([stored]),
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
    }
    await expect(
      manageFirewallRuleTool.handler(
        { ...add, ruleAction: "reject", comment: "rej", rejectWith: "tcp-reset" },
        makeContext([reported]),
      ),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });
});

describe("manage_firewall_rule - move", () => {
  // Wire order is evaluation order.
  const table: WireRecord[] = [
    { ".id": "*D", chain: "forward", action: "passthrough", dynamic: "true" },
    { ".id": "*1", chain: "input", action: "accept", comment: "established" },
    { ".id": "*2", chain: "input", action: "accept", comment: "mgmt" },
    { ".id": "*3", chain: "input", action: "drop", comment: "drop-ssh" },
    { ".id": "*4", chain: "input", action: "drop", comment: "drop-all" },
  ];
  const move = { action: "move", autoRevertSeconds: 0 };

  it("needs only ruleId and destination", () => {
    expect(
      manageFirewallRuleInputSchema.parse({ action: "move", ruleId: "*3", destination: "*1" }),
    ).toMatchObject({ action: "move", ruleId: "*3", destination: "*1" });
    expect(
      manageFirewallRuleInputSchema.parse({ action: "move", ruleId: "*3", destination: "end" }),
    ).toMatchObject({ destination: "end" });
  });

  it("the schema rejects a ruleId or destination that is not a RouterOS id", () => {
    expect(() =>
      manageFirewallRuleInputSchema.parse({ action: "move", ruleId: "3", destination: "*1" }),
    ).toThrow();
    expect(() =>
      manageFirewallRuleInputSchema.parse({ action: "move", ruleId: "*3", destination: "top" }),
    ).toThrow();
  });

  it("requires ruleId and destination, before any router call", async () => {
    const ctx = makeMoveContext(table);
    await expect(
      manageFirewallRuleTool.handler({ ...move, destination: "*1" }, ctx),
    ).rejects.toMatchObject({ code: "PARAM_REQUIRED", details: { param: "ruleId" } });
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*3" }, ctx),
    ).rejects.toMatchObject({ code: "PARAM_REQUIRED", details: { param: "destination" } });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it("rejects rule fields with move, and ruleId or destination with other actions", async () => {
    const ctx = makeMoveContext(table);
    await expect(
      manageFirewallRuleTool.handler(
        { ...move, ruleId: "*3", destination: "*1", comment: "drop-ssh" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PARAM_NOT_APPLICABLE", details: { param: "comment" } });
    await expect(
      manageFirewallRuleTool.handler(
        { action: "add", chain: "input", ruleAction: "drop", ruleId: "*3" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PARAM_NOT_APPLICABLE", details: { param: "ruleId" } });
  });

  it("moves the rule before the destination with the RouterOS move command", async () => {
    const ctx = makeMoveContext(table);
    const result = await manageFirewallRuleTool.handler(
      { ...move, ruleId: "*3", destination: "*1" },
      ctx,
    );
    expect(mocks(ctx).execute).toHaveBeenCalledWith("ip/firewall/filter/move", {
      numbers: "*3",
      destination: "*1",
    });
    expect(result.structuredContent).toMatchObject({
      action: "moved",
      id: "*3",
      destination: "*1",
      position: { before: 3, after: 1 },
    });
  });

  it("moves to the end by leaving destination out", async () => {
    const ctx = makeMoveContext(table);
    const result = await manageFirewallRuleTool.handler(
      { ...move, ruleId: "*2", destination: "end" },
      ctx,
    );
    expect(mocks(ctx).execute).toHaveBeenCalledWith("ip/firewall/filter/move", { numbers: "*2" });
    expect(result.structuredContent).toMatchObject({ position: { before: 2, after: 4 } });
  });

  it("moves within the IPv6 raw table", async () => {
    const ctx = makeMoveContext(table);
    await manageFirewallRuleTool.handler(
      { ...move, family: "ipv6", table: "raw", ruleId: "*4", destination: "*2" },
      ctx,
    );
    expect(ctx.routerClient.get).toHaveBeenCalledWith("ipv6/firewall/raw", {});
    expect(mocks(ctx).execute).toHaveBeenCalledWith("ipv6/firewall/raw/move", {
      numbers: "*4",
      destination: "*2",
    });
  });

  it("returns no_change when the rule already sits right before the destination", async () => {
    const ctx = makeMoveContext(table);
    const result = await manageFirewallRuleTool.handler(
      { ...move, ruleId: "*2", destination: "*3" },
      ctx,
    );
    expect(result.structuredContent).toMatchObject({
      action: "no_change",
      position: { before: 2, after: 2 },
    });
    expect(mocks(ctx).execute).not.toHaveBeenCalled();
  });

  it("returns no_change for end when the rule is already the last static rule", async () => {
    const ctx = makeMoveContext([...table, { ".id": "*D2", chain: "input", dynamic: "true" }]);
    const result = await manageFirewallRuleTool.handler(
      { ...move, ruleId: "*4", destination: "end" },
      ctx,
    );
    expect(result.structuredContent).toHaveProperty("action", "no_change");
    expect(mocks(ctx).execute).not.toHaveBeenCalled();
  });

  it("does not count a dynamic rule in between as a different position", async () => {
    const ctx = makeMoveContext([
      { ".id": "*1", chain: "input", action: "accept" },
      { ".id": "*D", chain: "input", action: "accept", dynamic: "true" },
      { ".id": "*2", chain: "input", action: "drop" },
    ]);
    const result = await manageFirewallRuleTool.handler(
      { ...move, ruleId: "*1", destination: "*2" },
      ctx,
    );
    expect(result.structuredContent).toHaveProperty("action", "no_change");
  });

  it("throws NOT_FOUND for an unknown ruleId or destination", async () => {
    const ctx = makeMoveContext(table);
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*99", destination: "*1" }, ctx),
    ).rejects.toMatchObject({
      category: "NOT_FOUND",
      code: "FIREWALL_RULE_NOT_FOUND",
      details: { ruleId: "*99" },
    });
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*3", destination: "*99" }, ctx),
    ).rejects.toMatchObject({ category: "NOT_FOUND", details: { destination: "*99" } });
    expect(mocks(ctx).execute).not.toHaveBeenCalled();
  });

  it("refuses to move a dynamic rule or to anchor on one", async () => {
    const ctx = makeMoveContext(table);
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*D", destination: "end" }, ctx),
    ).rejects.toMatchObject({ category: "VALIDATION", code: "DYNAMIC_RULE_NOT_MOVABLE" });
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*3", destination: "*D" }, ctx),
    ).rejects.toMatchObject({ code: "DYNAMIC_RULE_NOT_MOVABLE", details: { destination: "*D" } });
    expect(mocks(ctx).execute).not.toHaveBeenCalled();
  });

  it("refuses a destination equal to the rule", async () => {
    const ctx = makeMoveContext(table);
    await expect(
      manageFirewallRuleTool.handler({ ...move, ruleId: "*3", destination: "*3" }, ctx),
    ).rejects.toMatchObject({ code: "MOVE_DESTINATION_IS_RULE" });
  });

  it("dry run reports the old and new position and moves nothing", async () => {
    const ctx = makeMoveContext(table);
    const result = await manageFirewallRuleTool.handler(
      { action: "move", ruleId: "*3", destination: "*1", dryRun: true },
      ctx,
    );
    expect(result.structuredContent).toMatchObject({
      action: "dry_run",
      position: { before: 3, after: 1 },
      autoRevert: { wouldArm: true, seconds: 60 },
    });
    expect(result.content).toContain("from position 3 to 1");
    expect(mocks(ctx).execute).not.toHaveBeenCalled();
    expect(ctx.routerClient.create).not.toHaveBeenCalled();
  });

  it("guards a real move with a move-back job", async () => {
    const ctx = makeMoveContext(table);
    const result = await manageFirewallRuleTool.handler(
      { action: "move", ruleId: "*3", destination: "*1" },
      ctx,
    );
    const [, job] = mocks(ctx).create.mock.calls.find((c) => c[0] === SCHEDULER)!;
    expect(job["on-event"]).toContain("/ip firewall filter move numbers=*3 destination=*4");
    expect(result.structuredContent).toMatchObject({
      action: "moved",
      autoRevert: { status: "disarmed", revert: "move-back" },
    });
  });
});

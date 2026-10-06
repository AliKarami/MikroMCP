import { describe, it, expect, vi } from "vitest";
import { mangleTools } from "../../../src/domain/tools/mangle-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

const listMangleRulesTool = mangleTools[0];
const manageMangleRuleTool = mangleTools[1];

const listSchema = listMangleRulesTool.inputSchema;

const manageSchema = manageMangleRuleTool.inputSchema;

function makeContext(records: WireRecord[], createReturn?: Record<string, unknown>): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(fromWire(records)),
      create: vi.fn().mockResolvedValue(createReturn ?? { ".id": "*1", chain: "prerouting" }),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

describe("mangle tools", () => {
  describe("metadata", () => {
    it("exports 2 tools: list_mangle_rules and manage_mangle_rule", () => {
      expect(mangleTools).toHaveLength(2);
      expect(listMangleRulesTool.name).toBe("list_mangle_rules");
      expect(manageMangleRuleTool.name).toBe("manage_mangle_rule");
    });

    it("list_mangle_rules has correct annotations", () => {
      expect(listMangleRulesTool.annotations.readOnlyHint).toBe(true);
      expect(listMangleRulesTool.annotations.destructiveHint).toBe(false);
      expect(listMangleRulesTool.annotations.idempotentHint).toBe(true);
    });

    it("manage_mangle_rule has correct annotations", () => {
      expect(manageMangleRuleTool.annotations.readOnlyHint).toBe(false);
      expect(manageMangleRuleTool.annotations.destructiveHint).toBe(true);
      expect(manageMangleRuleTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_mangle_rules input schema", () => {
    it("accepts minimal input", () => {
      const r = listSchema.parse({ routerId: "r" });
      expect(r.chain).toBeUndefined();
    });

    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("manage_mangle_rule input schema", () => {
    it("accepts valid add with chain and comment", () => {
      const r = manageSchema.parse({
        routerId: "r",
        action: "add",
        comment: "mark-web",
        chain: "prerouting",
      });
      expect(r.dryRun).toBe(false);
    });

    it("rejects newDscpValue above 63", () => {
      expect(() =>
        manageSchema.parse({
          routerId: "r",
          action: "add",
          comment: "c",
          chain: "prerouting",
          newDscpValue: 64,
        }),
      ).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageSchema.parse({
          routerId: "r",
          action: "add",
          comment: "c",
          chain: "prerouting",
          unknownField: true,
        }),
      ).toThrow();
    });
  });

  describe("list_mangle_rules handler", () => {
    const sampleRules = [
      {
        ".id": "*1",
        chain: "prerouting",
        action: "mark-routing",
        "new-routing-mark": "isp1",
        disabled: "false",
        comment: "mark-isp1",
      },
      {
        ".id": "*2",
        chain: "forward",
        action: "mark-connection",
        disabled: "true",
        comment: "mark-conn",
      },
    ];

    it("returns all rules with correct total", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listMangleRulesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
    });

    it("filters by chain", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listMangleRulesTool.handler(
        { routerId: "test-router", chain: "prerouting" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
    });

    it("filters by disabled true", async () => {
      const ctx = makeContext(sampleRules);
      const result = await listMangleRulesTool.handler(
        { routerId: "test-router", disabled: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
    });
  });

  describe("manage_mangle_rule handler - add", () => {
    it("creates rule and returns created", async () => {
      const ctx = makeContext([]);
      const result = await manageMangleRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          comment: "mark-web",
          chain: "prerouting",
          ruleAction: "mark-routing",
          newRoutingMark: "isp1",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).toHaveBeenCalledWith("ip/firewall/mangle", {
        chain: "prerouting",
        action: "mark-routing",
        comment: "mark-web",
        "new-routing-mark": "isp1",
      });
    });

    it("returns already_exists when comment matches with same config", async () => {
      const existing = {
        ".id": "*1",
        chain: "prerouting",
        action: "mark-routing",
        "new-routing-mark": "isp1",
        comment: "mark-web",
        disabled: "false",
      };
      const ctx = makeContext([existing]);
      const result = await manageMangleRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          comment: "mark-web",
          chain: "prerouting",
          ruleAction: "mark-routing",
          newRoutingMark: "isp1",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
    });

    it("throws CONFLICT when comment matches with different config", async () => {
      const existing = {
        ".id": "*1",
        chain: "prerouting",
        action: "mark-routing",
        "new-routing-mark": "isp1",
        comment: "mark-web",
        disabled: "false",
      };
      const ctx = makeContext([existing]);
      await expect(
        manageMangleRuleTool.handler(
          {
            routerId: "test-router",
            action: "add",
            comment: "mark-web",
            chain: "output",
            ruleAction: "mark-routing",
            newRoutingMark: "isp2",
          },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
    });

    it("returns dry_run and does not call create", async () => {
      const ctx = makeContext([]);
      const result = await manageMangleRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          comment: "test",
          chain: "prerouting",
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

  describe("manage_mangle_rule handler - remove", () => {
    it("removes rule and calls remove with correct path and id", async () => {
      const existing = { ".id": "*1", comment: "mark-web", chain: "prerouting", disabled: "false" };
      const ctx = makeContext([existing]);
      const result = await manageMangleRuleTool.handler(
        { routerId: "test-router", action: "remove", comment: "mark-web" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("removed");
      const mockRemove = (ctx.routerClient as Record<string, unknown>).remove as ReturnType<
        typeof vi.fn
      >;
      expect(mockRemove).toHaveBeenCalledWith("ip/firewall/mangle", "*1");
    });

    it("returns already_removed when comment not found", async () => {
      const ctx = makeContext([]);
      const result = await manageMangleRuleTool.handler(
        { routerId: "test-router", action: "remove", comment: "nonexistent" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_removed");
    });
  });

  describe("manage_mangle_rule handler - enable/disable", () => {
    it("throws NOT_FOUND when comment not found", async () => {
      const ctx = makeContext([]);
      await expect(
        manageMangleRuleTool.handler(
          { routerId: "test-router", action: "enable", comment: "nonexistent" },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("calls update with disabled true when disabling", async () => {
      const existing = { ".id": "*1", comment: "mark-web", chain: "prerouting", disabled: "false" };
      const ctx = makeContext([existing]);
      const result = await manageMangleRuleTool.handler(
        { routerId: "test-router", action: "disable", comment: "mark-web" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("updated");
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/mangle", "*1", { disabled: "true" });
    });

    it("calls update with disabled false when enabling", async () => {
      const existing = { ".id": "*1", comment: "mark-web", chain: "prerouting", disabled: "true" };
      const ctx = makeContext([existing]);
      await manageMangleRuleTool.handler(
        { routerId: "test-router", action: "enable", comment: "mark-web" },
        ctx,
      );
      const mockUpdate = (ctx.routerClient as Record<string, unknown>).update as ReturnType<
        typeof vi.fn
      >;
      expect(mockUpdate).toHaveBeenCalledWith("ip/firewall/mangle", "*1", { disabled: "false" });
    });
  });
});

describe("manage_mangle_rule - field comparison on repeated add", () => {
  it("treats a /32 host address as equal to the bare address", async () => {
    const existing = {
      ".id": "*2",
      chain: "prerouting",
      action: "mark-routing",
      "src-address": "192.168.1.251",
      "new-routing-mark": "to-leg1",
      comment: "mark-ps5",
    };
    const result = await manageMangleRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        comment: "mark-ps5",
        chain: "prerouting",
        srcAddress: "192.168.1.251/32",
        ruleAction: "mark-routing",
        newRoutingMark: "to-leg1",
      },
      makeContext([existing]),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it.each([
    ["mark-routing", "newRoutingMark", "new-routing-mark"],
    ["mark-connection", "newConnectionMark", "new-connection-mark"],
    ["mark-packet", "newPacketMark", "new-packet-mark"],
  ])(
    "treats a numeric %s mark from the router as equal to the requested string",
    async (ruleAction, param, property) => {
      // RouterOS sends "100"; the response parser turns it into the number 100.
      const existing = {
        ".id": "*3",
        action: ruleAction,
        chain: "prerouting",
        [property]: "100",
        comment: "numeric-marks",
      };
      const ctx = makeContext([existing]);
      const result = await manageMangleRuleTool.handler(
        {
          routerId: "test-router",
          action: "add",
          comment: "numeric-marks",
          chain: "prerouting",
          ruleAction,
          [param]: "100",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    },
  );

  // Real rules from RB5009 (RouterOS 7.24.2, list_mangle_rules, 2026-10-06), written back
  // as the wire strings REST sends; makeContext parses them like RouterOSRestClient.get.
  const MSS_CLAMP_WG: WireRecord = {
    ".id": "*A",
    action: "change-mss",
    bytes: "353820",
    chain: "forward",
    comment: "MSS clamp wg-leg1",
    dynamic: "false",
    invalid: "false",
    "new-mss": "clamp-to-pmtu",
    "out-interface": "wg-leg1",
    packets: "5897",
    passthrough: "true",
    protocol: "tcp",
    "tcp-flags": "syn",
  };
  // Dynamic rule: the router reports neither passthrough nor protocol for it.
  const FASTTRACK_DUMMY: WireRecord = {
    ".id": "*C",
    action: "passthrough",
    bytes: "593383747678",
    chain: "forward",
    comment: "special dummy rule to show fasttrack counters",
    dynamic: "true",
    packets: "490690209",
  };

  const sameAdd = {
    routerId: "test-router",
    action: "add",
    comment: "MSS clamp wg-leg1",
    chain: "forward",
    ruleAction: "change-mss",
    protocol: "tcp",
    outInterface: "wg-leg1",
    tcpFlags: "syn",
    newMss: "clamp-to-pmtu",
  };
  const ctxWith = (wire: WireRecord) => makeContext([wire]);

  it("returns already_exists for the same rule read back from the router", async () => {
    const result = await manageMangleRuleTool.handler(sameAdd, ctxWith(MSS_CLAMP_WG));
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it.each([
    ["dst-port", { dstPort: "443" }],
    ["src-port", { srcPort: "1024" }],
    ["in-interface", { inInterface: "bridge1" }],
    ["out-interface", { outInterface: "ether1" }],
    ["tcp-flags", { tcpFlags: "syn,!ack" }],
    ["new-mss", { newMss: 1360 }],
  ])("throws CONFLICT when %s differs, with both values in details", async (property, change) => {
    const [stored] = fromWire([MSS_CLAMP_WG]);
    await expect(
      manageMangleRuleTool.handler({ ...sameAdd, ...change }, ctxWith(MSS_CLAMP_WG)),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: {
        existing: { [property]: stored[property] },
        requested: { [property]: Object.values(change)[0] },
      },
    });
  });

  it("throws CONFLICT when protocol differs, and lists the action only when it was compared", async () => {
    // A udp request cannot keep change-mss, so it omits the action and its value.
    const add = { ...sameAdd, ruleAction: undefined, newMss: undefined, tcpFlags: undefined };
    const err = await manageMangleRuleTool
      .handler({ ...add, protocol: "udp" }, ctxWith(MSS_CLAMP_WG))
      .catch((e: unknown) => e as { code: string; details: Record<string, object> });
    expect(err).toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: { existing: { protocol: "tcp" }, requested: { protocol: "udp" } },
    });
    expect(err.details.existing).not.toHaveProperty("action");
    expect(err.details.requested).not.toHaveProperty("action");
  });

  // Derived from *A in two fields, because no single-field change gives a change-dscp
  // rule: action change-mss -> change-dscp, new-mss -> new-dscp. The CHR integration
  // test reads back a real change-dscp rule with the same keys.
  const { "new-mss": _mss, ...MSS_CLAMP_WG_WITHOUT_MSS } = MSS_CLAMP_WG;
  const CHANGE_DSCP = { ...MSS_CLAMP_WG_WITHOUT_MSS, action: "change-dscp", "new-dscp": "46" };
  const dscpAdd = { ...sameAdd, ruleAction: "change-dscp", newMss: undefined };

  it("returns already_exists for a change-dscp rule with the same new-dscp", async () => {
    const result = await manageMangleRuleTool.handler(
      { ...dscpAdd, newDscpValue: 46 },
      ctxWith(CHANGE_DSCP),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("throws CONFLICT when a reported new-dscp differs", async () => {
    await expect(
      manageMangleRuleTool.handler({ ...dscpAdd, newDscpValue: 10 }, ctxWith(CHANGE_DSCP)),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: { existing: { "new-dscp": 46 }, requested: { "new-dscp": 10 } },
    });
  });

  // Real record from CHR 7.24.2 (same on 7.23.2): a rule added over REST with
  // new-connection-mark and no action, as earlier versions of this tool did. RouterOS
  // stored it without an action field and dropped the mark. Counters left out.
  const NO_ACTION_RULE = {
    ".id": "*2",
    chain: "prerouting",
    comment: "mikromcp-probe-no-action-connection-mark",
    dynamic: "false",
    invalid: "true",
  };
  const noActionAdd = {
    routerId: "test-router",
    action: "add",
    comment: NO_ACTION_RULE.comment,
    chain: "prerouting",
  };

  it("treats a record without an action as the default accept", async () => {
    const result = await manageMangleRuleTool.handler(
      { ...noActionAdd, ruleAction: "accept" },
      ctxWith(NO_ACTION_RULE),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("throws CONFLICT for a rule added without an action when its mark action is given", async () => {
    await expect(
      manageMangleRuleTool.handler(
        { ...noActionAdd, ruleAction: "mark-connection", newConnectionMark: "probe" },
        ctxWith(NO_ACTION_RULE),
      ),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: {
        existing: { action: "accept", "new-connection-mark": undefined },
        requested: { action: "mark-connection", "new-connection-mark": "probe" },
      },
    });
  });

  it("throws CONFLICT when an explicit ruleAction differs, with both actions in details", async () => {
    await expect(
      manageMangleRuleTool.handler(
        { ...sameAdd, ruleAction: "mark-packet", newMss: undefined, newPacketMark: "wg" },
        ctxWith(MSS_CLAMP_WG),
      ),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: {
        existing: { action: "change-mss", "new-packet-mark": undefined },
        requested: { action: "mark-packet", "new-packet-mark": "wg" },
      },
    });
  });

  it("compares an explicit ruleAction against a rule without new-* values", async () => {
    const add = {
      routerId: "test-router",
      action: "add",
      comment: FASTTRACK_DUMMY.comment,
      chain: "forward",
    };
    const same = await manageMangleRuleTool.handler(
      { ...add, ruleAction: "passthrough" },
      ctxWith(FASTTRACK_DUMMY),
    );
    expect((same.structuredContent as Record<string, unknown>).action).toBe("already_exists");

    await expect(
      manageMangleRuleTool.handler({ ...add, ruleAction: "accept" }, ctxWith(FASTTRACK_DUMMY)),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: { existing: { action: "passthrough" }, requested: { action: "accept" } },
    });
  });

  it("does not compare the action when ruleAction is omitted", async () => {
    const result = await manageMangleRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        comment: FASTTRACK_DUMMY.comment,
        chain: "forward",
      },
      ctxWith(FASTTRACK_DUMMY),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("lists every compared field, with the effective passthrough, in CONFLICT details", async () => {
    await expect(
      manageMangleRuleTool.handler({ ...sameAdd, dstPort: "443" }, ctxWith(MSS_CLAMP_WG)),
    ).rejects.toMatchObject({
      details: {
        existing: { protocol: "tcp", "out-interface": "wg-leg1", passthrough: true },
        requested: {
          "dst-port": "443",
          protocol: "tcp",
          "out-interface": "wg-leg1",
          passthrough: true,
        },
      },
    });
  });

  it("treats an omitted passthrough as the RouterOS default yes", async () => {
    const result = await manageMangleRuleTool.handler(
      { ...sameAdd, passthrough: true },
      ctxWith(MSS_CLAMP_WG),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("throws CONFLICT when passthrough differs", async () => {
    await expect(
      manageMangleRuleTool.handler({ ...sameAdd, passthrough: false }, ctxWith(MSS_CLAMP_WG)),
    ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
  });

  it("does not compare passthrough when the router does not report it", async () => {
    const result = await manageMangleRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        comment: FASTTRACK_DUMMY.comment,
        chain: "forward",
        passthrough: false,
      },
      ctxWith(FASTTRACK_DUMMY),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("matches a protocol number against the name RouterOS stores", async () => {
    const result = await manageMangleRuleTool.handler(
      { ...sameAdd, protocol: "6" },
      ctxWith(MSS_CLAMP_WG),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("treats protocol all as no protocol", async () => {
    const result = await manageMangleRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        comment: FASTTRACK_DUMMY.comment,
        chain: "forward",
        protocol: "all",
      },
      ctxWith(FASTTRACK_DUMMY),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it("matches a numeric custom chain read back from the router", async () => {
    // Derived: the same rule in a jump chain named "100", which parses to a number.
    const ctx = ctxWith({ ...MSS_CLAMP_WG, chain: "100" });
    const result = await manageMangleRuleTool.handler({ ...sameAdd, chain: "100" }, ctx);
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");

    const listed = await listMangleRulesTool.handler(
      { routerId: "test-router", chain: "100" },
      ctx,
    );
    expect((listed.structuredContent as Record<string, unknown>).total).toBe(1);
  });

  it("matches passthrough=no read back from the router", async () => {
    // Derived: the same rule with passthrough=no.
    const result = await manageMangleRuleTool.handler(
      { ...sameAdd, passthrough: false },
      ctxWith({ ...MSS_CLAMP_WG, passthrough: "false" }),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });
});

describe("manage_mangle_rule - action and its value parameter", () => {
  const add = {
    routerId: "test-router",
    action: "add",
    comment: "MSS clamp wg-leg1",
    chain: "prerouting",
  };

  const createdBody = async (params: Record<string, unknown>) => {
    const ctx = makeContext([]);
    await manageMangleRuleTool.handler({ ...add, ...params }, ctx);
    const create = (ctx.routerClient as Record<string, unknown>).create as ReturnType<typeof vi.fn>;
    return create.mock.calls[0][1] as Record<string, string>;
  };

  it("sends action accept, the RouterOS default, when ruleAction is omitted", async () => {
    expect(await createdBody({ protocol: "tcp" })).toMatchObject({ action: "accept" });
  });

  it.each([
    ["mark-routing", { newRoutingMark: "to-leg1" }, { "new-routing-mark": "to-leg1" }],
    ["mark-connection", { newConnectionMark: "ps5" }, { "new-connection-mark": "ps5" }],
    ["mark-packet", { newPacketMark: "ps5" }, { "new-packet-mark": "ps5" }],
    ["change-dscp", { newDscpValue: 46 }, { "new-dscp": "46" }],
    [
      "change-mss",
      { protocol: "tcp", tcpFlags: "syn", newMss: "clamp-to-pmtu" },
      { "tcp-flags": "syn", "new-mss": "clamp-to-pmtu" },
    ],
    ["change-mss", { protocol: "tcp", tcpFlags: "syn", newMss: 1360 }, { "new-mss": "1360" }],
  ])("sends action %s with its value", async (ruleAction, value, wire) => {
    expect(await createdBody({ ruleAction, ...value })).toMatchObject({
      action: ruleAction,
      ...wire,
    });
  });

  it("shows the action in the dry-run diff", async () => {
    const result = await manageMangleRuleTool.handler(
      {
        ...add,
        ruleAction: "change-mss",
        protocol: "tcp",
        tcpFlags: "syn",
        newMss: "clamp-to-pmtu",
        dryRun: true,
      },
      makeContext([]),
    );
    expect((result.structuredContent as Record<string, unknown>).diff).toContainEqual({
      property: "action",
      before: null,
      after: "change-mss",
    });
  });

  it.each([
    ["newRoutingMark", "omitted", undefined, { newRoutingMark: "to-leg1" }, "mark-routing"],
    ["newConnectionMark", "omitted", undefined, { newConnectionMark: "ps5" }, "mark-connection"],
    ["newPacketMark", "omitted", undefined, { newPacketMark: "ps5" }, "mark-packet"],
    ["newDscpValue", "omitted", undefined, { newDscpValue: 46 }, "change-dscp"],
    ["newMss", "omitted", undefined, { newMss: "clamp-to-pmtu" }, "change-mss"],
    ["newDscpValue", "accept", "accept", { newDscpValue: 46 }, "change-dscp"],
    [
      "newRoutingMark",
      "mark-connection",
      "mark-connection",
      { newConnectionMark: "c", newRoutingMark: "r" },
      "mark-routing",
    ],
  ])(
    "rejects %s with ruleAction %s before any router call",
    async (param, _label, ruleAction, values, requiredRuleAction) => {
      const ctx = makeContext([]);
      await expect(
        manageMangleRuleTool.handler({ ...add, ruleAction, ...values }, ctx),
      ).rejects.toMatchObject({
        code: "MANGLE_FIELD_NOT_APPLICABLE",
        details: { ruleAction: ruleAction ?? "accept", param, requiredRuleAction },
      });
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mark-routing", "newRoutingMark"],
    ["mark-connection", "newConnectionMark"],
    ["mark-packet", "newPacketMark"],
    ["change-dscp", "newDscpValue"],
    ["change-mss", "newMss"],
  ])("rejects ruleAction %s without %s before any router call", async (ruleAction, param) => {
    const ctx = makeContext([]);
    await expect(manageMangleRuleTool.handler({ ...add, ruleAction }, ctx)).rejects.toMatchObject({
      code: "MANGLE_ACTION_VALUE_REQUIRED",
      details: { ruleAction, param },
    });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it.each(["remove", "enable", "disable"])(
    "rejects ruleAction on %s before any router call",
    async (action) => {
      const ctx = makeContext([]);
      await expect(
        manageMangleRuleTool.handler(
          { routerId: "test-router", action, comment: "MSS clamp wg-leg1", ruleAction: "accept" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "RULE_ACTION_ADD_ONLY" });
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["forward", "MANGLE_CHAIN_NOT_APPLICABLE"],
    ["postrouting", "MANGLE_CHAIN_NOT_APPLICABLE"],
    ["input", "MANGLE_CHAIN_NOT_APPLICABLE"],
  ])("rejects mark-routing in chain %s before any router call", async (chain, code) => {
    const ctx = makeContext([]);
    await expect(
      manageMangleRuleTool.handler(
        { ...add, chain, ruleAction: "mark-routing", newRoutingMark: "to-leg1" },
        ctx,
      ),
    ).rejects.toMatchObject({ code, details: { chain } });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it.each(["prerouting", "output", "to-leg1-marks"])(
    "allows mark-routing in chain %s",
    async (chain) => {
      expect(
        await createdBody({ chain, ruleAction: "mark-routing", newRoutingMark: "to-leg1" }),
      ).toMatchObject({ chain, action: "mark-routing" });
    },
  );

  it.each([
    ["change-mss without protocol", { ruleAction: "change-mss", newMss: "clamp-to-pmtu" }],
    [
      "change-mss with protocol udp",
      { ruleAction: "change-mss", protocol: "udp", newMss: "clamp-to-pmtu" },
    ],
    [
      "change-mss without tcpFlags syn",
      { ruleAction: "change-mss", protocol: "tcp", newMss: "clamp-to-pmtu" },
    ],
    [
      "change-mss with tcpFlags !syn",
      { ruleAction: "change-mss", protocol: "tcp", tcpFlags: "!syn", newMss: "clamp-to-pmtu" },
    ],
    ["tcpFlags without protocol", { tcpFlags: "syn" }],
    ["tcpFlags with protocol udp", { protocol: "udp", tcpFlags: "syn" }],
  ])("rejects %s before any router call", async (_label, params) => {
    const ctx = makeContext([]);
    await expect(manageMangleRuleTool.handler({ ...add, ...params }, ctx)).rejects.toMatchObject({
      code: "MANGLE_TCP_REQUIRED",
    });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it("takes protocol 6 as TCP", async () => {
    expect(
      await createdBody({
        ruleAction: "change-mss",
        protocol: "6",
        tcpFlags: "syn",
        newMss: "clamp-to-pmtu",
      }),
    ).toMatchObject({ protocol: "6", action: "change-mss" });
  });

  it.each([
    ["ruleAction jump", { ruleAction: "jump" }],
    ["an empty newRoutingMark", { ruleAction: "mark-routing", newRoutingMark: "" }],
    ["an empty newConnectionMark", { ruleAction: "mark-connection", newConnectionMark: "" }],
    ["an empty newPacketMark", { ruleAction: "mark-packet", newPacketMark: "" }],
    ["an empty tcpFlags", { protocol: "tcp", tcpFlags: "" }],
    ["newMss auto", { newMss: "auto" }],
    ["newMss 65536", { newMss: 65536 }],
  ])("schema rejects %s", (_label, value) => {
    expect(manageMangleRuleTool.inputSchema.safeParse({ ...add, ...value }).success).toBe(false);
  });
});

describe("manage_mangle_rule - empty comment", () => {
  it.each(["add", "remove", "enable", "disable"])(
    "%s with an empty comment fails validation before any router call",
    async (action) => {
      const ctx = makeContext([]);
      expect(
        manageMangleRuleTool.inputSchema.safeParse({ routerId: "r", action, comment: "" }).success,
      ).toBe(false);
      await expect(
        manageMangleRuleTool.handler(
          { routerId: "test-router", action, comment: "", chain: "prerouting" },
          ctx,
        ),
      ).rejects.toThrow();
      expect(ctx.routerClient.get).not.toHaveBeenCalled();
    },
  );
});

describe("manage_mangle_rule - control characters in comment", () => {
  it("rejects a comment of control characters only, before any router call", async () => {
    const ctx = makeContext([]);
    await expect(
      manageMangleRuleTool.handler(
        { routerId: "test-router", action: "remove", comment: "\x01\n" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "COMMENT_EMPTY" });
    expect(ctx.routerClient.get).not.toHaveBeenCalled();
  });

  it("looks up and stores the comment without control characters, as manage_firewall_rule does", async () => {
    const ctx = makeContext([]);
    await manageMangleRuleTool.handler(
      { routerId: "test-router", action: "add", comment: "mark\nweb", chain: "prerouting" },
      ctx,
    );
    expect(ctx.routerClient.get).toHaveBeenCalledWith("ip/firewall/mangle", {
      filter: { comment: "markweb" },
    });
    expect(ctx.routerClient.create).toHaveBeenCalledWith(
      "ip/firewall/mangle",
      expect.objectContaining({ comment: "markweb" }),
    );
  });
});

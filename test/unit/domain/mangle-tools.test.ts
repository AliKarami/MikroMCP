import { describe, it, expect, vi } from "vitest";
import { mangleTools } from "../../../src/domain/tools/mangle-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";
import { parseRecord } from "../../../src/adapter/response-parser.js";

const listMangleRulesTool = mangleTools[0];
const manageMangleRuleTool = mangleTools[1];

const listSchema = z
  .object({
    routerId: z.string(),
    chain: z.string().optional(),
    action: z.string().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

const manageSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "remove", "enable", "disable"]),
    comment: z.string(),
    chain: z.string().optional(),
    dryRun: z.boolean().default(false),
    srcAddress: z.string().optional(),
    dstAddress: z.string().optional(),
    srcAddressList: z.string().optional(),
    dstAddressList: z.string().optional(),
    protocol: z.string().optional(),
    srcPort: z.string().optional(),
    dstPort: z.string().optional(),
    inInterface: z.string().optional(),
    outInterface: z.string().optional(),
    newRoutingMark: z.string().optional(),
    newConnectionMark: z.string().optional(),
    newDscpValue: z.number().int().min(0).max(63).optional(),
    passthrough: z.boolean().optional(),
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
          newRoutingMark: "isp1",
        },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("created");
      const mockCreate = (ctx.routerClient as Record<string, unknown>).create as ReturnType<
        typeof vi.fn
      >;
      expect(mockCreate).toHaveBeenCalled();
    });

    it("returns already_exists when comment matches with same config", async () => {
      const existing = {
        ".id": "*1",
        chain: "prerouting",
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
            chain: "forward",
            newRoutingMark: "isp2",
          },
          ctx,
        ),
      ).rejects.toThrow();
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
        newRoutingMark: "to-leg1",
      },
      makeContext([existing]),
    );
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  // Real rules from RB5009 (RouterOS 7.24.2, list_mangle_rules, 2026-10-06), written back
  // as the wire strings REST sends and fed through parseRecord like RouterOSRestClient.get.
  const MSS_CLAMP_WG = {
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
  const FASTTRACK_DUMMY = {
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
    protocol: "tcp",
    outInterface: "wg-leg1",
  };
  const ctxWith = (wire: Record<string, string>) => makeContext([parseRecord(wire)]);

  it("returns already_exists for the same rule read back from the router", async () => {
    const result = await manageMangleRuleTool.handler(sameAdd, ctxWith(MSS_CLAMP_WG));
    expect((result.structuredContent as Record<string, unknown>).action).toBe("already_exists");
  });

  it.each([
    ["protocol", { protocol: "udp" }],
    ["dst-port", { dstPort: "443" }],
    ["src-port", { srcPort: "1024" }],
    ["in-interface", { inInterface: "bridge1" }],
    ["out-interface", { outInterface: "ether1" }],
    ["new-routing-mark", { newRoutingMark: "to-leg1" }],
  ])("throws CONFLICT when %s differs, with both values in details", async (property, change) => {
    const stored: Record<string, unknown> = parseRecord(MSS_CLAMP_WG);
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

  it("throws CONFLICT when a reported new-dscp differs", async () => {
    // Derived: the same rule with new-dscp set; RB5009 has no rule that sets it.
    await expect(
      manageMangleRuleTool.handler(
        { ...sameAdd, newDscpValue: 10 },
        ctxWith({ ...MSS_CLAMP_WG, "new-dscp": "46" }),
      ),
    ).rejects.toMatchObject({
      code: "MANGLE_RULE_CONFLICT",
      details: { existing: { "new-dscp": 46 }, requested: { "new-dscp": 10 } },
    });
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

  it("does not compare passthrough or new-dscp when the router does not report them", async () => {
    const result = await manageMangleRuleTool.handler(
      {
        routerId: "test-router",
        action: "add",
        comment: FASTTRACK_DUMMY.comment,
        chain: "forward",
        passthrough: false,
        newDscpValue: 10,
      },
      ctxWith(FASTTRACK_DUMMY),
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

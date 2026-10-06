import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { PROTOCOL_NAMES } from "../../src/domain/tools/rule-match.js";

const harness = createHarness();

const COMMENT = "mikromcp-itest-mangle";
const RULE = {
  comment: COMMENT,
  chain: "forward",
  srcAddress: "203.0.113.0/24",
  protocol: "tcp",
  dstPort: "8443",
};

const PROTOCOL_RULE = { comment: "mikromcp-itest-mangle-protocol", chain: "forward" };
const protocolRule = liveResource(harness.context, "ip/firewall/mangle", {
  comment: PROTOCOL_RULE.comment,
});

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ip/firewall/mangle", {
  comment: COMMENT,
});

// Fields RouterOS may report only for actions that use them.
const ACTION_FIELDS_RULE = {
  comment: "mikromcp-itest-mangle-action-fields",
  chain: "forward",
  srcAddress: "203.0.113.0/24",
  ruleAction: "change-dscp",
  passthrough: false,
  newDscpValue: 46,
};

const MSS_RULE = {
  comment: "mikromcp-itest-mangle-mss",
  chain: "forward",
  protocol: "tcp",
  tcpFlags: "syn",
  outInterface: "ether1",
  ruleAction: "change-mss",
  newMss: "clamp-to-pmtu",
};

// What earlier versions of the tool created: a connection mark and no action.
const NO_ACTION_RULE = {
  chain: "forward",
  comment: "mikromcp-itest-mangle-no-action",
  "src-address": "203.0.113.0/24",
  "new-connection-mark": "mikromcp-itest",
};

const actionFieldsRule = liveResource(harness.context, "ip/firewall/mangle", {
  comment: ACTION_FIELDS_RULE.comment,
});

const mssRule = liveResource(harness.context, "ip/firewall/mangle", { comment: MSS_RULE.comment });
const noActionRule = liveResource(harness.context, "ip/firewall/mangle", {
  comment: NO_ACTION_RULE.comment,
});

beforeAll(async () => {
  await removeLeftover();
  await actionFieldsRule.removeLeftover();
  await mssRule.removeLeftover();
  await noActionRule.removeLeftover();
  await protocolRule.removeLeftover();
});

afterAll(async () => {
  await removeLeftover();
  await actionFieldsRule.removeLeftover();
  await mssRule.removeLeftover();
  await noActionRule.removeLeftover();
  await protocolRule.removeLeftover();
  harness.close();
});

describe("manage_mangle_rule repeated add against live CHR", () => {
  it("add creates the rule", async () => {
    const result = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("created");
    // No ruleAction: the tool sends the RouterOS default.
    expect(await findOnRouter()).toMatchObject({ action: "accept" });
  });

  it("identical add, read back from the router, is already_exists", async () => {
    const result = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different dstPort throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_mangle_rule", {
        action: "add",
        ...RULE,
        dstPort: "9443",
      }),
    ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
  });

  it("add with a different protocol throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_mangle_rule", {
        action: "add",
        ...RULE,
        protocol: "udp",
      }),
    ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
  });

  it("remove deletes the rule", async () => {
    const result = await runTool(harness.context, "manage_mangle_rule", {
      action: "remove",
      comment: COMMENT,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("a repeated add with passthrough and newDscpValue, read back from the router, is already_exists", async () => {
    const created = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...ACTION_FIELDS_RULE,
    });
    expect(created.structuredContent.action).toBe("created");

    expect(await actionFieldsRule.find()).toMatchObject({ action: "change-dscp", "new-dscp": 46 });

    const again = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...ACTION_FIELDS_RULE,
    });
    expect(again.structuredContent.action).toBe("already_exists");
  });

  it("change-mss with clamp-to-pmtu reads back as such, and a repeated add is already_exists", async () => {
    const created = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...MSS_RULE,
    });
    expect(created.structuredContent.action).toBe("created");
    expect(await mssRule.find()).toMatchObject({
      action: "change-mss",
      "tcp-flags": "syn",
      "new-mss": "clamp-to-pmtu",
    });

    const again = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...MSS_RULE,
    });
    expect(again.structuredContent.action).toBe("already_exists");
  });

  it("add with a different explicit ruleAction throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_mangle_rule", {
        action: "add",
        ...MSS_RULE,
        ruleAction: "mark-packet",
        newMss: undefined,
        newPacketMark: "mikromcp-itest",
      }),
    ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
  });

  it("a rule added without an action keeps neither, and an add with its mark action throws CONFLICT", async () => {
    await harness.context.routerClient.create("ip/firewall/mangle", NO_ACTION_RULE);
    // RouterOS stores no action field and drops the mark the default accept cannot use.
    const stored = await noActionRule.find();
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("action");
    expect(stored).not.toHaveProperty("new-connection-mark");

    await expect(
      runTool(harness.context, "manage_mangle_rule", {
        action: "add",
        comment: NO_ACTION_RULE.comment,
        chain: "forward",
        srcAddress: "203.0.113.0/24",
        ruleAction: "mark-connection",
        newConnectionMark: "mikromcp-itest",
      }),
    ).rejects.toMatchObject({ code: "MANGLE_RULE_CONFLICT" });
  });

  it("stores each protocol number 0-255 as PROTOCOL_NAMES says", async () => {
    await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...PROTOCOL_RULE,
      protocol: "6",
    });
    const id = (await protocolRule.find())![".id"];
    const mismatches: string[] = [];
    for (let n = 0; n <= 255; n++) {
      await harness.context.routerClient.update("ip/firewall/mangle", id, { protocol: String(n) });
      const stored = String((await protocolRule.find())?.protocol);
      const expected = PROTOCOL_NAMES[String(n)] ?? String(n);
      if (stored !== expected) mismatches.push(`${n}: stored ${stored}, expected ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("a repeated add with a protocol number, stored as its name, is already_exists", async () => {
    await protocolRule.removeLeftover();
    const add = { action: "add", ...PROTOCOL_RULE, protocol: "17" };
    expect(
      (await runTool(harness.context, "manage_mangle_rule", add)).structuredContent.action,
    ).toBe("created");
    expect(await protocolRule.find()).toMatchObject({ protocol: "udp" });
    expect(
      (await runTool(harness.context, "manage_mangle_rule", add)).structuredContent.action,
    ).toBe("already_exists");
  });
});

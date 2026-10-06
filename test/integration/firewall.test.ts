import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";
import { isTrue } from "../../src/adapter/response-parser.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const COMMENT = "mikromcp-itest-fw";
const RULE = {
  chain: "forward",
  ruleAction: "accept",
  srcAddress: "203.0.113.0/24",
  comment: COMMENT,
};

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ip/firewall/filter", {
  comment: COMMENT,
});

// A comment with spaces exercises the percent-encoded GET filter (#77).
const NAT_COMMENT = "mikromcp itest dst-nat";
const PORT_FORWARD = {
  table: "nat",
  chain: "dstnat",
  ruleAction: "dst-nat",
  protocol: "tcp",
  dstAddress: "198.51.100.10",
  dstPort: "18443",
  toAddresses: "192.0.2.10",
  toPorts: "443",
  comment: NAT_COMMENT,
};
const nat = liveResource(harness.context, "ip/firewall/nat", { comment: NAT_COMMENT });

const STATE_COMMENT = "mikromcp-itest-fw-not-invalid";
const NOT_INVALID = {
  chain: "forward",
  ruleAction: "accept",
  connectionState: "!invalid",
  comment: STATE_COMMENT,
};
const notInvalid = liveResource(harness.context, "ip/firewall/filter", { comment: STATE_COMMENT });

beforeAll(async () => {
  await removeLeftover();
  await nat.removeLeftover();
  await notInvalid.removeLeftover();
});

afterAll(async () => {
  await removeLeftover();
  await nat.removeLeftover();
  await notInvalid.removeLeftover();
  harness.close();
});

describe("manage_firewall_rule lifecycle against live CHR", () => {
  it("dry-run add does not touch the router", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...RULE,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("add creates the rule", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await findOnRouter();
    expect(onRouter).toBeDefined();
    expect(onRouter!.chain).toBe("forward");
  });

  it("identical add is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with the same comment but different action throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_firewall_rule", {
        action: "add",
        ...RULE,
        ruleAction: "drop",
      }),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });

  it("list_firewall_rules finds the rule by chain", async () => {
    const result = await runTool(harness.context, "list_firewall_rules", { chain: "forward" });

    const rules = result.structuredContent.rules as RouterOSRecord[];
    expect(rules.map((r) => r.comment)).toContain(COMMENT);
  });

  it("disable toggles the rule off", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "disable",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("disable");
    expect(isTrue((await findOnRouter())!.disabled)).toBe(true);
  });

  it("disabling again reports no_change", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "disable",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("no_change");
  });

  it("enable toggles the rule back on", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "enable",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("enable");
    expect(isTrue((await findOnRouter())!.disabled)).toBe(false);
  });

  it("remove deletes the rule", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "remove",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing rule throws NOT_FOUND", async () => {
    const error = await runTool(harness.context, "manage_firewall_rule", {
      action: "remove",
      ...RULE,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("FIREWALL_RULE_NOT_FOUND");
  });
});

describe("manage_firewall_rule dst-nat port forward against live CHR", () => {
  it("add creates the rule with its NAT targets", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...PORT_FORWARD,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await nat.find();
    expect(onRouter).toMatchObject({ action: "dst-nat", "to-addresses": "192.0.2.10" });
    expect(String(onRouter!["to-ports"])).toBe("443");
  });

  it("identical add finds the rule by a comment with spaces (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...PORT_FORWARD,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different to-ports throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_firewall_rule", {
        action: "add",
        ...PORT_FORWARD,
        toPorts: "8443",
      }),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });

  it("remove deletes the rule", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "remove",
      ...PORT_FORWARD,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await nat.find()).toBeUndefined();
  });
});

describe("manage_firewall_rule negated connection-state against live CHR", () => {
  it("stores connection-state=!invalid as sent", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...NOT_INVALID,
    });

    expect(result.structuredContent.action).toBe("created");
    // How RouterOS stores a negated state set was not verified before this test.
    expect((await notInvalid.find())!["connection-state"]).toBe("!invalid");
  });

  it("identical add is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_firewall_rule", {
      action: "add",
      ...NOT_INVALID,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with the non-negated state throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_firewall_rule", {
        action: "add",
        ...NOT_INVALID,
        connectionState: "invalid",
      }),
    ).rejects.toMatchObject({ code: "FIREWALL_RULE_CONFLICT" });
  });
});

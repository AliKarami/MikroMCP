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

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
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

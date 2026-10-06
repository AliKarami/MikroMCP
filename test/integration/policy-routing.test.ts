import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const TABLE = "mikromcp-itest-rt";
const RULE = { table: TABLE, srcAddress: "203.0.113.0/24", ruleAction: "lookup-only-in-table" };

const rule = liveResource(harness.context, "routing/rule", {
  "src-address": RULE.srcAddress,
});
const table = liveResource(harness.context, "routing/table", { name: TABLE });

async function removeLeftovers(): Promise<void> {
  // A rule references its table, so the rule goes first.
  await rule.removeLeftover();
  await table.removeLeftover();
}

beforeAll(async () => {
  await removeLeftovers();
  await runTool(harness.context, "manage_routing_table", { action: "add", name: TABLE, fib: true });
});

afterAll(async () => {
  await removeLeftovers();
  harness.close();
});

describe("manage_routing_rule against live CHR", () => {
  it("add creates an active rule with its action and table", async () => {
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await rule.find();
    expect(onRouter).toBeDefined();
    // A rule without an action reads back with `.about` and no table.
    expect(onRouter![".about"]).toBeUndefined();
    expect(onRouter!.action).toBe("lookup-only-in-table");
    expect(onRouter!.table).toBe(TABLE);
  });

  it("identical add is already_exists, no duplicate", async () => {
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("already_exists");
    const records = await harness.context.routerClient.get<RouterOSRecord>("routing/rule", {
      filter: { "src-address": RULE.srcAddress },
    });
    expect(records).toHaveLength(1);
  });

  it("add without ruleAction finds the rule whatever its action", async () => {
    const { ruleAction: _omitted, ...withoutAction } = RULE;
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "add",
      ...withoutAction,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different ruleAction throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_routing_rule", {
        action: "add",
        ...RULE,
        ruleAction: "lookup",
      }),
    ).rejects.toMatchObject({ code: "ROUTING_RULE_CONFLICT" });
  });

  it("list_routing_rules filters by the table", async () => {
    const result = await runTool(harness.context, "list_routing_rules", { table: TABLE });

    expect(result.structuredContent.total).toBe(1);
  });

  it("remove deletes the rule", async () => {
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "remove",
      table: TABLE,
      srcAddress: RULE.srcAddress,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await rule.find()).toBeUndefined();
  });
});

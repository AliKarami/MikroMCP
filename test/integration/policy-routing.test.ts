import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

// A numeric name is valid for /routing table; the response parser turns it into a number.
const TABLE = "100";
const RULE = { table: TABLE, srcAddress: "203.0.113.0/24" };

const rule = liveResource(harness.context, "routing/rule", {
  "src-address": RULE.srcAddress,
});
const table = liveResource(harness.context, "routing/table", { name: TABLE });

async function removeLeftovers(): Promise<void> {
  // The rule references the table, so it goes first.
  await rule.removeLeftover();
  await table.removeLeftover();
}

beforeAll(removeLeftovers);

afterAll(async () => {
  await removeLeftovers();
  harness.close();
});

describe("manage_routing_rule with a numeric table name against live CHR", () => {
  it("creates the table", async () => {
    const result = await runTool(harness.context, "manage_routing_table", {
      action: "add",
      name: TABLE,
      fib: true,
    });

    expect(result.structuredContent.action).toBe("created");
  });

  it("add creates the rule", async () => {
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("created");
    expect(await rule.find()).toBeDefined();
  });

  it("identical add finds the rule (already_exists), no duplicate", async () => {
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

  it("list_routing_rules filters by the numeric table name", async () => {
    const result = await runTool(harness.context, "list_routing_rules", { table: TABLE });

    expect(result.structuredContent.total).toBe(1);
  });

  it("remove deletes the rule", async () => {
    const result = await runTool(harness.context, "manage_routing_rule", {
      action: "remove",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await rule.find()).toBeUndefined();
  });
});

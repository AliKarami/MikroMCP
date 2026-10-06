import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const FILTER_PATH = "ip/firewall/filter";
const SRC_ADDRESS = "198.51.100.77";

// A disabled rule without a comment: the record an empty-comment lookup would have to hit.
const uncommented = liveResource(
  harness.context,
  FILTER_PATH,
  { "src-address": SRC_ADDRESS },
  (record) => record.comment === undefined,
);

beforeAll(async () => {
  await uncommented.removeLeftover();
  await harness.context.routerClient.create(FILTER_PATH, {
    chain: "forward",
    action: "accept",
    "src-address": SRC_ADDRESS,
    disabled: "true",
  });
});

afterAll(async () => {
  await uncommented.removeLeftover();
  harness.close();
});

describe("empty comment against live CHR", () => {
  it("RouterOS REST matches no rule for ?comment=, not even one without a comment", async () => {
    expect(await uncommented.find()).toBeDefined();

    const matched = await harness.context.routerClient.get<RouterOSRecord>(FILTER_PATH, {
      filter: { comment: "" },
    });

    expect(matched).toEqual([]);
  });

  it("manage_firewall_rule rejects an empty comment", async () => {
    await expect(
      runTool(harness.context, "manage_firewall_rule", {
        action: "add",
        chain: "forward",
        ruleAction: "accept",
        srcAddress: SRC_ADDRESS,
        comment: "",
      }),
    ).rejects.toThrow();
  });

  it("manage_mangle_rule rejects an empty comment", async () => {
    await expect(
      runTool(harness.context, "manage_mangle_rule", {
        action: "add",
        chain: "forward",
        srcAddress: SRC_ADDRESS,
        comment: "",
      }),
    ).rejects.toThrow();
  });
});

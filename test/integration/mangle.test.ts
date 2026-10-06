import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";

const harness = createHarness();

const COMMENT = "mikromcp-itest-mangle";
const RULE = {
  comment: COMMENT,
  chain: "forward",
  srcAddress: "203.0.113.0/24",
  protocol: "tcp",
  dstPort: "8443",
};

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ip/firewall/mangle", {
  comment: COMMENT,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_mangle_rule repeated add against live CHR", () => {
  it("add creates the rule", async () => {
    const result = await runTool(harness.context, "manage_mangle_rule", {
      action: "add",
      ...RULE,
    });

    expect(result.structuredContent.action).toBe("created");
    expect(await findOnRouter()).toBeDefined();
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
});

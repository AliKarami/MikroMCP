import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";

const harness = createHarness();

const NAME = "vlan-itest";
const VLAN_ID = 421;

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "interface/vlan", {
  name: NAME,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_vlan lifecycle against live CHR", () => {
  it("add creates the VLAN", async () => {
    const result = await runTool(harness.context, "manage_vlan", {
      action: "add",
      name: NAME,
      vlanId: VLAN_ID,
      parentInterface: "ether1",
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await findOnRouter();
    expect(onRouter).toBeDefined();
    expect(String(onRouter!["vlan-id"])).toBe(String(VLAN_ID));
  });

  it("identical add is idempotent (already_exists) with the parsed numeric vlan-id", async () => {
    const result = await runTool(harness.context, "manage_vlan", {
      action: "add",
      name: NAME,
      vlanId: VLAN_ID,
      parentInterface: "ether1",
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different vlan-id throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_vlan", {
        action: "add",
        name: NAME,
        vlanId: VLAN_ID + 1,
        parentInterface: "ether1",
      }),
    ).rejects.toMatchObject({ code: "VLAN_NAME_CONFLICT" });
  });

  it("remove deletes the VLAN", async () => {
    const result = await runTool(harness.context, "manage_vlan", {
      action: "remove",
      name: NAME,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing VLAN reports not_found", async () => {
    const result = await runTool(harness.context, "manage_vlan", {
      action: "remove",
      name: NAME,
    });

    expect(result.structuredContent.action).toBe("not_found");
  });
});

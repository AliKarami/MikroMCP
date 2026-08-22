import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";

const harness = createHarness();

const NAME = "vrrp-itest";
const VRID = 42;

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "interface/vrrp", {
  name: NAME,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_vrrp_instance lifecycle against live CHR", () => {
  it("add creates the VRRP instance", async () => {
    const result = await runTool(harness.context, "manage_vrrp_instance", {
      action: "add",
      name: NAME,
      interface: "ether1",
      vrid: VRID,
    });

    expect(result.structuredContent.action).toBe("created");
    expect(await findOnRouter()).toBeDefined();
  });

  it("identical add is idempotent (already_exists) with the parsed numeric vrid", async () => {
    const result = await runTool(harness.context, "manage_vrrp_instance", {
      action: "add",
      name: NAME,
      interface: "ether1",
      vrid: VRID,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different vrid throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_vrrp_instance", {
        action: "add",
        name: NAME,
        interface: "ether1",
        vrid: VRID + 1,
      }),
    ).rejects.toMatchObject({ code: "VRRP_CONFLICT" });
  });

  it("remove deletes the instance", async () => {
    const result = await runTool(harness.context, "manage_vrrp_instance", {
      action: "remove",
      name: NAME,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing instance reports not_found", async () => {
    const result = await runTool(harness.context, "manage_vrrp_instance", {
      action: "remove",
      name: NAME,
    });

    expect(result.structuredContent.action).toBe("not_found");
  });
});

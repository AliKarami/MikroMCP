import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isTrue } from "../../src/adapter/response-parser.js";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";

const harness = createHarness();

const BRIDGE = "br-vlan-itest";
// The bridge port is a VLAN interface on ether1 with an otherwise unused VLAN id, so
// the suite never puts the CHR's management interface itself into the test bridge.
const PORT = "vl-brv-itest";
const PORT_VLAN_ID = 3921;
const VLAN_IDS = "3922,3923";

// RouterOS adds dynamic entries of its own (from PVIDs) that cannot be removed; skip them.
const vlanEntry = liveResource(
  harness.context,
  "interface/bridge/vlan",
  { bridge: BRIDGE },
  (r) => !isTrue(r.dynamic),
);
const bridgePort = liveResource(harness.context, "interface/bridge/port", {
  bridge: BRIDGE,
  interface: PORT,
});
const bridgeIface = liveResource(harness.context, "interface/bridge", { name: BRIDGE });
const portIface = liveResource(harness.context, "interface/vlan", { name: PORT });

async function removeLeftovers(): Promise<void> {
  await vlanEntry.removeLeftover();
  await bridgePort.removeLeftover();
  await bridgeIface.removeLeftover();
  await portIface.removeLeftover();
}

beforeAll(async () => {
  await removeLeftovers();
  await runTool(harness.context, "manage_bridge", { action: "create", name: BRIDGE });
  await runTool(harness.context, "manage_vlan", {
    action: "add",
    name: PORT,
    vlanId: PORT_VLAN_ID,
    parentInterface: "ether1",
  });
  await runTool(harness.context, "manage_bridge_port", {
    action: "add",
    bridge: BRIDGE,
    interface: PORT,
  });
});

afterAll(async () => {
  await removeLeftovers();
  harness.close();
});

describe("bridge VLAN filtering against live CHR", () => {
  it("add creates the bridge VLAN entry and warns that filtering is off", async () => {
    const result = await runTool(harness.context, "manage_bridge_vlan", {
      action: "add",
      bridge: BRIDGE,
      vlanIds: VLAN_IDS,
      tagged: [BRIDGE],
      untagged: [PORT],
    });

    expect(result.structuredContent.action).toBe("created");
    expect((result.structuredContent.warnings as string[]).length).toBe(1);
    const onRouter = await vlanEntry.find();
    expect(String(onRouter!["vlan-ids"])).toMatch(/3922/);
  });

  it("add with the VLANs in another order is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_bridge_vlan", {
      action: "add",
      bridge: BRIDGE,
      vlanIds: "3923,3922",
      tagged: [BRIDGE],
      untagged: [PORT],
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("list_bridge_vlans finds the entry by a VLAN id inside it", async () => {
    const result = await runTool(harness.context, "list_bridge_vlans", {
      bridge: BRIDGE,
      vlanId: 3923,
    });

    expect(result.structuredContent.total).toBe(1);
  });

  it("manage_bridge_port update sets the PVID, then reports no_change", async () => {
    const updated = await runTool(harness.context, "manage_bridge_port", {
      action: "update",
      bridge: BRIDGE,
      interface: PORT,
      pvid: 3922,
      frameTypes: "admit-only-untagged-and-priority-tagged",
    });
    expect(updated.structuredContent.action).toBe("updated");
    expect(String((await bridgePort.find())!.pvid)).toBe("3922");

    const again = await runTool(harness.context, "manage_bridge_port", {
      action: "update",
      bridge: BRIDGE,
      interface: PORT,
      pvid: 3922,
      frameTypes: "admit-only-untagged-and-priority-tagged",
    });
    expect(again.structuredContent.action).toBe("no_change");
  });

  it("manage_bridge update enables vlan-filtering with a lock-out warning, then disables it", async () => {
    const enabled = await runTool(harness.context, "manage_bridge", {
      action: "update",
      name: BRIDGE,
      vlanFiltering: true,
    });
    expect(enabled.structuredContent.action).toBe("updated");
    expect((enabled.structuredContent.warnings as string[])[0]).toMatch(/lock-out/);

    const disabled = await runTool(harness.context, "manage_bridge", {
      action: "update",
      name: BRIDGE,
      vlanFiltering: false,
    });
    expect(disabled.structuredContent.action).toBe("updated");
  });

  it("remove deletes the entry, and a second remove is NOT_FOUND", async () => {
    const result = await runTool(harness.context, "manage_bridge_vlan", {
      action: "remove",
      bridge: BRIDGE,
      vlanIds: VLAN_IDS,
    });
    expect(result.structuredContent.action).toBe("removed");
    expect(await vlanEntry.find()).toBeUndefined();

    await expect(
      runTool(harness.context, "manage_bridge_vlan", {
        action: "remove",
        bridge: BRIDGE,
        vlanIds: VLAN_IDS,
      }),
    ).rejects.toMatchObject({ code: "BRIDGE_VLAN_NOT_FOUND" });
  });
});

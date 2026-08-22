import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, runTool } from "./helpers/harness.js";
import { isTrue } from "../../src/adapter/response-parser.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

// The instance itself is provisioned by global-setup (RouterOS 7.16+ has no
// OVPN server until one is added); these tests only flip its state.
async function serverOnRouter(): Promise<RouterOSRecord> {
  const records = await harness.context.routerClient.get<RouterOSRecord>(
    "interface/ovpn-server/server",
  );
  expect(records.length).toBeGreaterThan(0);
  return records[0];
}

async function forceDisabled(): Promise<void> {
  const server = await serverOnRouter();
  if (!isTrue(server.disabled)) {
    await harness.context.routerClient.update("interface/ovpn-server/server", server[".id"], {
      disabled: "yes",
    });
  }
}

beforeAll(forceDisabled);

afterAll(async () => {
  await forceDisabled();
  harness.close();
});

describe("OVPN server lifecycle against live CHR (7.16+ instance dialect)", () => {
  it("get_ovpn_server returns the provisioned instance", async () => {
    const result = await runTool(harness.context, "get_ovpn_server", {});

    expect(result.structuredContent.server).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("disable on an already-disabled server reports no_change", async () => {
    const result = await runTool(harness.context, "manage_ovpn_server", { action: "disable" });

    expect(result.structuredContent.action).toBe("no_change");
  });

  it("enable activates the server via the disabled field", async () => {
    const result = await runTool(harness.context, "manage_ovpn_server", { action: "enable" });

    expect(result.structuredContent.action).toBe("enabled");
    expect(isTrue((await serverOnRouter()).disabled)).toBe(false);
  });

  it("enable again reports no_change", async () => {
    const result = await runTool(harness.context, "manage_ovpn_server", { action: "enable" });

    expect(result.structuredContent.action).toBe("no_change");
  });

  it("disable deactivates the server", async () => {
    const result = await runTool(harness.context, "manage_ovpn_server", { action: "disable" });

    expect(result.structuredContent.action).toBe("disabled");
    expect(isTrue((await serverOnRouter()).disabled)).toBe(true);
  });
});

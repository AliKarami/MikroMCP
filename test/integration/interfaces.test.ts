import { describe, it, expect, afterAll } from "vitest";
import { createHarness, runTool, ITEST_ROUTER_ID } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

afterAll(() => harness.close());

describe("list_interfaces against live CHR", () => {
  it("lists the CHR's ethernet interfaces", async () => {
    const result = await runTool(harness.context, "list_interfaces");

    expect(result.structuredContent.routerId).toBe(ITEST_ROUTER_ID);
    const interfaces = result.structuredContent.interfaces as RouterOSRecord[];
    expect(interfaces.length).toBeGreaterThan(0);
    expect(interfaces.map((i) => i.name)).toContain("ether1");
    expect(result.structuredContent.total).toBeGreaterThan(0);
  });

  it("supports the type filter", async () => {
    const result = await runTool(harness.context, "list_interfaces", { type: "ether" });

    // interface/<type> returns type-specific records, which carry no `type`
    // field — assert on the names instead.
    const interfaces = result.structuredContent.interfaces as RouterOSRecord[];
    expect(interfaces.length).toBeGreaterThan(0);
    expect(interfaces.map((i) => i.name)).toContain("ether1");
  });
});

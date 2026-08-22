import { describe, it, expect, afterAll } from "vitest";
import { createHarness, runTool, ITEST_ROUTER_ID } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

afterAll(() => harness.close());

describe("get_system_status against live CHR", () => {
  it("returns identity and resource sections", async () => {
    const result = await runTool(harness.context, "get_system_status");

    expect(result.structuredContent.routerId).toBe(ITEST_ROUTER_ID);
    const sections = result.structuredContent.sections as Record<string, Record<string, unknown>>;
    expect(sections.identity?.name).toBeDefined();
    expect(sections.resource?.version).toBeDefined();
    expect(String(sections.resource.version)).toMatch(/^7\./);
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("REST response parsing against live CHR", () => {
  it("converts RouterOS wire strings to typed values", async () => {
    const interfaces = await harness.context.routerClient.get<RouterOSRecord>("interface");

    expect(interfaces.length).toBeGreaterThan(0);
    const ether = interfaces.find((i) => i.name === "ether1");
    expect(ether).toBeDefined();
    expect(typeof ether!.running).toBe("boolean");
    expect(typeof ether!.mtu).toBe("number");
    expect(ether![".id"]).toMatch(/^\*/);
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { createHarness, runTool, ITEST_ROUTER_ID } from "./helpers/harness.js";
import { allTools } from "../../src/domain/tools/index.js";

const harness = createHarness();

afterAll(() => harness.close());

// Read tools that pass schema validation with defaults but cannot answer on a
// bare CHR. Every entry needs a reason.
const SKIP: Record<string, string> = {
  get_upgrade_status: "CHR is virtual — /system/routerboard does not exist",
  get_container_config: "container package is not installed on a bare CHR",
  list_containers: "container package is not installed on a bare CHR",
  list_container_envs: "container package is not installed on a bare CHR",
  list_container_mounts: "container package is not installed on a bare CHR",
};

// RouterOS read tools that are callable with just a routerId — required
// parameters (ping targets, file paths, SwOS endpoints) exclude a tool via
// the schema check, so new list/get tools are swept automatically.
const eligible = allTools.filter(
  (t) =>
    t.annotations.readOnlyHint &&
    (t.platform ?? "routeros") === "routeros" &&
    !t.skipRouterContext &&
    !(t.name in SKIP) &&
    t.inputSchema.safeParse({ routerId: ITEST_ROUTER_ID }).success,
);

describe("read-tool smoke sweep against live CHR", () => {
  it("sweeps a meaningful share of the read tools", () => {
    expect(eligible.length).toBeGreaterThan(30);
  });

  it.each(eligible.map((t) => [t.name] as const))("%s answers", async (name) => {
    const result = await runTool(harness.context, name, { routerId: ITEST_ROUTER_ID });

    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.structuredContent).toBeTruthy();
  });

  for (const [name, reason] of Object.entries(SKIP)) {
    it.skip(`${name} — skipped: ${reason}`, () => {});
  }
});

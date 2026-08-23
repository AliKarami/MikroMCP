import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool, ITEST_ROUTER_ID } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const NAME = "rollback.mikromcp.invalid";
const ADDRESS = "192.0.2.99";
const STEP = {
  tool: "manage_dns_entry",
  params: { action: "add", name: NAME, address: ADDRESS },
};

let journalId: string;

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ip/dns/static", {
  name: NAME,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("plan/apply/rollback lifecycle against live CHR", () => {
  it("plan_changes previews the write without applying it", async () => {
    const result = await runTool(harness.context, "plan_changes", {
      routerId: ITEST_ROUTER_ID,
      steps: [STEP],
    });

    const steps = result.structuredContent.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect((steps[0].structuredDryRun as Record<string, unknown>).action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("apply_plan executes the write, snapshotting and journaling it", async () => {
    const result = await runTool(harness.context, "apply_plan", {
      routerId: ITEST_ROUTER_ID,
      steps: [STEP],
    });

    expect(result.structuredContent.status).toBe("success");
    const steps = result.structuredContent.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    journalId = steps[0].journalId as string;
    expect(journalId).toBeTruthy();
    expect(await findOnRouter()).toBeDefined();
  });

  it("rollback_change dry-run shows the restore plan without applying it", async () => {
    const result = await runTool(harness.context, "rollback_change", {
      routerId: ITEST_ROUTER_ID,
      journalId,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeDefined();
  });

  it("rollback_change restores the pre-write state", async () => {
    const result = await runTool(harness.context, "rollback_change", {
      routerId: ITEST_ROUTER_ID,
      journalId,
    });

    expect(result.structuredContent.action).toBe("rolled_back");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("rollback_change with an unknown journal id throws NOT_FOUND", async () => {
    await expect(
      runTool(harness.context, "rollback_change", {
        routerId: ITEST_ROUTER_ID,
        journalId: "does-not-exist",
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_ENTRY_NOT_FOUND" });
  });
});

// Set-menu singletons carry no `.id`, so a restore cannot address them for
// update — it has to write the whole record back through POST <path>/set.
// Regression cover for #68.
describe("singleton rollback against live CHR", () => {
  const readCacheSize = async (): Promise<string> => {
    const [dns] = await harness.context.routerClient.get<RouterOSRecord>("ip/dns");
    return String((dns as Record<string, unknown>)["cache-size"]);
  };

  let original: string;
  let singletonJournalId: string;

  beforeAll(async () => {
    original = await readCacheSize();
  });

  afterAll(async () => {
    await harness.context.routerClient.execute("ip/dns/set", { "cache-size": original });
  });

  it("apply_plan writes the singleton and journals it", async () => {
    const target = String(Number(original) + 512);

    const result = await runTool(harness.context, "apply_plan", {
      routerId: ITEST_ROUTER_ID,
      steps: [{ tool: "manage_dns_settings", params: { cacheSize: Number(target) } }],
    });

    expect(result.structuredContent.status).toBe("success");
    const steps = result.structuredContent.steps as Array<Record<string, unknown>>;
    singletonJournalId = steps[0].journalId as string;
    expect(singletonJournalId).toBeTruthy();
    expect(await readCacheSize()).toBe(target);
  });

  it("rollback_change restores the singleton through /set", async () => {
    const result = await runTool(harness.context, "rollback_change", {
      routerId: ITEST_ROUTER_ID,
      journalId: singletonJournalId,
    });

    expect(result.structuredContent.action).toBe("rolled_back");
    expect(await readCacheSize()).toBe(original);
  });
});

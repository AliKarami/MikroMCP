import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool, ITEST_ROUTER_ID } from "./helpers/harness.js";

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

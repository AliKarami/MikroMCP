import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import type { RouterOSRecord } from "../../src/types.js";

// Uses the maximum delay and removes the entry afterwards, so the CHR never reboots.
const DELAY = 3600;

function wallSeconds(date: string, time: string): number {
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const legacy = /^([a-z]{3})\/(\d{2})\/(\d{4})$/i.exec(date);
  const [h, m, s] = time.split(":").map(Number);
  const ms = iso
    ? Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), h, m, s)
    : Date.UTC(
        Number(legacy![3]),
        months.indexOf(legacy![1].toLowerCase()),
        Number(legacy![2]),
        h,
        m,
        s,
      );
  return ms / 1000;
}

describe("reboot with a delay against live CHR", () => {
  const harness = createHarness();
  const entry = liveResource(harness.context, "system/scheduler", { name: "mikromcp-reboot" });

  beforeAll(entry.removeLeftover);
  afterAll(async () => {
    await entry.removeLeftover();
    harness.close();
  });

  it("schedules the first run `delay` seconds after the router clock, not at once", async () => {
    const [clock] = await harness.context.routerClient.get<RouterOSRecord>("system/clock");
    const result = await runTool(harness.context, "reboot", { delay: DELAY });
    expect((result.structuredContent as Record<string, unknown>).action).toBe("reboot_scheduled");

    const job = await entry.find();
    expect(job).toBeDefined();
    const nextRun = String(job!["next-run"]);
    const [nextDate, nextTime] = nextRun.includes(" ")
      ? nextRun.split(" ")
      : [String(clock.date), nextRun];
    const ahead =
      wallSeconds(nextDate, nextTime) - wallSeconds(String(clock.date), String(clock.time));
    expect(ahead).toBeGreaterThanOrEqual(DELAY - 5);
    expect(ahead).toBeLessThanOrEqual(DELAY + 5);
    expect(Number(job!["run-count"])).toBe(0);
  });
});

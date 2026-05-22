import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneSnapshots } from "../../../../src/domain/snapshot/retention.js";

describe("pruneSnapshots", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mmcp-ret-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("deletes snapshot files older than maxAgeDays and keeps recent ones", async () => {
    const routerDir = join(dir, "r1");
    mkdirSync(routerDir, { recursive: true });
    const oldFile = join(routerDir, "old.json");
    const newFile = join(routerDir, "new.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(newFile, "{}");
    const fortyDaysAgo = Date.now() / 1000 - 40 * 86400;
    utimesSync(oldFile, fortyDaysAgo, fortyDaysAgo);

    const removed = await pruneSnapshots(dir, 30);

    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("returns 0 when the snapshot dir does not exist", async () => {
    expect(await pruneSnapshots(join(dir, "missing"), 30)).toBe(0);
  });
});

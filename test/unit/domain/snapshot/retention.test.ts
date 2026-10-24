import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pruneSnapshots,
  rotateAndPruneJournal,
} from "../../../../src/domain/snapshot/retention.js";
import {
  journalSegmentName,
  journalSegmentPaths,
  readJournalEntries,
} from "../../../../src/domain/snapshot/write-journal.js";

describe("pruneSnapshots", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcp-ret-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

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

describe("rotateAndPruneJournal", () => {
  let dir: string;
  let journal: string;
  const NOW = new Date("2026-10-24T12:00:00Z");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcp-jret-"));
    journal = join(dir, "write-journal.ndjson");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
  const setMtime = (path: string, when: Date) => utimesSync(path, when, when);

  it("rotates a journal whose oldest entry is a day old into a dated segment, keeping mode", async () => {
    const content =
      '{"id":"torn' + "\n" + line({ id: "a", ts: daysAgo(2).toISOString(), phase: "attempt" });
    writeFileSync(journal, content, { mode: 0o640 });

    const result = await rotateAndPruneJournal(journal, 30, NOW);

    expect(result).toEqual({ rotated: true, removed: 0 });
    expect(existsSync(journal)).toBe(false);
    const segments = journalSegmentPaths(journal);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(/write-journal\.20261024T120000Z-[0-9a-f]{12}\.ndjson$/);
    expect(readFileSync(segments[0], "utf-8")).toBe(content);
    expect(statSync(segments[0]).mode & 0o777).toBe(0o640);
  });

  it("leaves a journal younger than a day in place", async () => {
    writeFileSync(journal, line({ id: "a", ts: daysAgo(0.5).toISOString(), phase: "attempt" }));

    expect(await rotateAndPruneJournal(journal, 30, NOW)).toEqual({ rotated: false, removed: 0 });
    expect(existsSync(journal)).toBe(true);
    expect(journalSegmentPaths(journal)).toEqual([]);
  });

  it("deletes segments last written before the retention cutoff and keeps the rest", async () => {
    const old = journalSegmentName(journal, daysAgo(45), "s1");
    const recent = journalSegmentName(journal, daysAgo(10), "s2");
    writeFileSync(old, line({ id: "o", ts: daysAgo(45).toISOString(), phase: "attempt" }));
    writeFileSync(recent, line({ id: "r", ts: daysAgo(10).toISOString(), phase: "attempt" }));
    setMtime(old, daysAgo(40));
    setMtime(recent, daysAgo(9));
    writeFileSync(join(dir, "write-journal.notes.ndjson"), "unrelated");

    const result = await rotateAndPruneJournal(journal, 30, NOW);

    expect(result).toEqual({ rotated: false, removed: 1 });
    expect(journalSegmentPaths(journal)).toEqual([recent]);
    expect(existsSync(join(dir, "write-journal.notes.ndjson"))).toBe(true);
  });

  it("never prunes a just-rotated segment of an idle journal, however old its mtime", async () => {
    const fresh = journalSegmentName(journal, NOW, "s3");
    writeFileSync(fresh, line({ id: "i", ts: daysAgo(60).toISOString(), phase: "attempt" }));
    setMtime(fresh, daysAgo(60));

    expect(await rotateAndPruneJournal(journal, 30, NOW)).toEqual({ rotated: false, removed: 0 });
    expect(journalSegmentPaths(journal)).toEqual([fresh]);
  });

  it("does nothing when no journal exists", async () => {
    expect(await rotateAndPruneJournal(join(dir, "missing.ndjson"), 30, NOW)).toEqual({
      rotated: false,
      removed: 0,
    });
  });

  it("an append that opened the journal before rotation lands in the segment and is still read", async () => {
    writeFileSync(journal, line({ id: "a", ts: daysAgo(2).toISOString(), phase: "attempt" }));
    // A concurrent writer holding the file open across the rename, as appendFile would.
    const fd = openSync(journal, "a");

    await rotateAndPruneJournal(journal, 30, NOW);
    writeSync(fd, line({ id: "a", ts: NOW.toISOString(), phase: "success" }));
    closeSync(fd);
    writeFileSync(journal, line({ id: "b", ts: NOW.toISOString(), phase: "attempt" }), {
      flag: "a",
    });

    expect(readJournalEntries(journal).map((e) => `${e.id}:${e.phase}`)).toEqual([
      "a:attempt",
      "a:success",
      "b:attempt",
    ]);
  });
});

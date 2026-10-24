import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("nanoid", () => ({ nanoid: () => "journal-id-1" }));

import * as fsp from "node:fs/promises";
import {
  journalSegmentName,
  journalSegmentRotatedAt,
  parseJournal,
  readJournalEntries,
  recordAttempt,
  recordOutcome,
} from "../../../../src/domain/snapshot/write-journal.js";

describe("recordAttempt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a journalId", () => {
    const id = recordAttempt({
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "manage_route",
      routerId: "edge-01",
      params: { action: "add", dstAddress: "10.0.0.0/8" },
      snapshotIds: ["snap-abc"],
    });
    expect(id).toBe("journal-id-1");
  });

  it("appends a JSON line to the journal file", async () => {
    recordAttempt({
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "manage_route",
      routerId: "edge-01",
      params: { action: "add" },
      snapshotIds: [],
    });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledOnce();
    });
    const line = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.phase).toBe("attempt");
    expect(parsed.tool).toBe("manage_route");
    expect(parsed.id).toBe("journal-id-1");
  });

  it("redacts sensitive param keys", async () => {
    recordAttempt({
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "manage_route",
      routerId: "edge-01",
      params: { action: "add", password: "secret" },
      snapshotIds: [],
    });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledOnce();
    });
    const line = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(line).not.toContain("secret");
  });

  it("records dryRun only when the call was a dry run", async () => {
    const base = {
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "write_swos_blob",
      routerId: "sw-01",
      params: {},
      snapshotIds: ["snap-1"],
    };
    recordAttempt({ ...base, dryRun: true });
    recordAttempt({ ...base, dryRun: false });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledTimes(2);
    });
    const calls = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse((calls[0][1] as string).trim()).dryRun).toBe(true);
    expect(JSON.parse((calls[1][1] as string).trim())).not.toHaveProperty("dryRun");
  });
});

describe("recordOutcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends a success line with durationMs", async () => {
    recordOutcome({
      journalPath: "/tmp/journal.ndjson",
      journalId: "j1",
      phase: "success",
      durationMs: 120,
    });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledOnce();
    });
    const line = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.id).toBe("j1");
    expect(parsed.phase).toBe("success");
    expect(parsed.durationMs).toBe(120);
  });

  it("appends a failure line with outcome code", async () => {
    recordOutcome({
      journalPath: "/tmp/journal.ndjson",
      journalId: "j1",
      phase: "failure",
      outcome: "ROUTER_DOWN",
      durationMs: 50,
    });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledOnce();
    });
    const line = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.phase).toBe("failure");
    expect(parsed.outcome).toBe("ROUTER_DOWN");
  });
});

describe("parseJournal", () => {
  it("skips blank, torn and non-object lines", () => {
    const raw = ['{"id":"a","phase":"attempt"}', "", "42", "[1]", '{"id":"b","phase":"suc'].join(
      "\n",
    );
    expect(parseJournal(raw)).toEqual([{ id: "a", phase: "attempt" }]);
  });
});

describe("readJournalEntries", () => {
  // node:fs is real here; only node:fs/promises is mocked in this file.
  let dir: string;
  let journal: string;
  beforeEach(async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    dir = fs.mkdtempSync(`${os.tmpdir()}/mmcp-jread-`);
    journal = `${dir}/write-journal.ndjson`;
  });
  afterEach(async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
  const write = async (path: string, text: string) => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fs.writeFileSync(path, text);
  };

  it("keeps an entry seen in both the current file and a segment once (rotation mid-read)", async () => {
    const a = line({ id: "a", ts: "2026-10-24T10:00:00Z", phase: "attempt" });
    await write(journal, a);
    await write(journalSegmentName(journal, new Date("2026-10-24T12:00:00Z"), "s1"), a);

    expect(readJournalEntries(journal)).toEqual([
      { id: "a", ts: "2026-10-24T10:00:00Z", phase: "attempt" },
    ]);
  });

  it("orders entries by timestamp whatever order the segments were rotated in", async () => {
    // A stale second rotation can leave newer entries in an earlier-named segment.
    await write(
      journalSegmentName(journal, new Date("2026-10-24T12:00:00Z"), "s1"),
      line({ id: "new", ts: "2026-10-24T11:00:00Z", phase: "attempt" }),
    );
    await write(
      journalSegmentName(journal, new Date("2026-10-24T12:00:00Z"), "s2"),
      line({ id: "old", ts: "2026-10-23T09:00:00Z", phase: "attempt" }),
    );
    await write(journal, line({ id: "newest", ts: "2026-10-24T12:30:00Z", phase: "attempt" }));

    expect(readJournalEntries(journal).map((e) => e.id)).toEqual(["old", "new", "newest"]);
  });

  it("returns nothing when no journal exists", () => {
    expect(readJournalEntries(`${dir}/missing.ndjson`)).toEqual([]);
  });
});

describe("journalSegmentName", () => {
  it("gives two rotations in the same second distinct names (PID-1 containers share a volume)", () => {
    const when = new Date("2026-10-24T12:00:00Z");
    const a = journalSegmentName("/d/write-journal.ndjson", when);
    const b = journalSegmentName("/d/write-journal.ndjson", when);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\/d\/write-journal\.20261024T120000Z-[0-9a-f]{12}\.ndjson$/);
  });
});

describe("journalSegmentRotatedAt", () => {
  it("reads the rotation time from a segment name", () => {
    const when = new Date("2026-10-24T12:34:56Z");
    expect(journalSegmentRotatedAt(journalSegmentName("/d/write-journal.ndjson", when, "s9"))).toBe(
      when.getTime(),
    );
    expect(journalSegmentRotatedAt("/d/write-journal.ndjson")).toBeNaN();
  });
});

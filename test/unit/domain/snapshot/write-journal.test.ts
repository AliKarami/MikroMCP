import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({ appendFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("nanoid", () => ({ nanoid: () => "journal-id-1" }));

import * as fs from "node:fs";
import { recordAttempt, recordOutcome } from "../../../../src/domain/snapshot/write-journal.js";

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

  it("appends a JSON line to the journal file", () => {
    recordAttempt({
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "manage_route",
      routerId: "edge-01",
      params: { action: "add" },
      snapshotIds: [],
    });
    expect(fs.appendFileSync).toHaveBeenCalledOnce();
    const line = (fs.appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.phase).toBe("attempt");
    expect(parsed.tool).toBe("manage_route");
    expect(parsed.id).toBe("journal-id-1");
  });

  it("redacts sensitive param keys", () => {
    recordAttempt({
      journalPath: "/tmp/journal.ndjson",
      identityId: "alice",
      role: "admin",
      tool: "manage_route",
      routerId: "edge-01",
      params: { action: "add", password: "secret" },
      snapshotIds: [],
    });
    const line = (fs.appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(line).not.toContain("secret");
  });
});

describe("recordOutcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends a success line with durationMs", () => {
    recordOutcome({ journalPath: "/tmp/journal.ndjson", journalId: "j1", phase: "success", durationMs: 120 });
    const line = (fs.appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.id).toBe("j1");
    expect(parsed.phase).toBe("success");
    expect(parsed.durationMs).toBe(120);
  });

  it("appends a failure line with outcome code", () => {
    recordOutcome({ journalPath: "/tmp/journal.ndjson", journalId: "j1", phase: "failure", outcome: "ROUTER_DOWN", durationMs: 50 });
    const line = (fs.appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.phase).toBe("failure");
    expect(parsed.outcome).toBe("ROUTER_DOWN");
  });
});

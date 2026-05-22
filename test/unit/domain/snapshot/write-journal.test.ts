import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({ appendFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("nanoid", () => ({ nanoid: () => "journal-id-1" }));

import * as fsp from "node:fs/promises";
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
});

describe("recordOutcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends a success line with durationMs", async () => {
    recordOutcome({ journalPath: "/tmp/journal.ndjson", journalId: "j1", phase: "success", durationMs: 120 });
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
    recordOutcome({ journalPath: "/tmp/journal.ndjson", journalId: "j1", phase: "failure", outcome: "ROUTER_DOWN", durationMs: 50 });
    await vi.waitFor(() => {
      expect(fsp.appendFile).toHaveBeenCalledOnce();
    });
    const line = (fsp.appendFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.phase).toBe("failure");
    expect(parsed.outcome).toBe("ROUTER_DOWN");
  });
});

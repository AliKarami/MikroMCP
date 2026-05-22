import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
}));
vi.mock("nanoid", () => ({ nanoid: () => "abc123" }));

import * as fsp from "node:fs/promises";
import { takeSnapshot, loadSnapshot } from "../../../../src/domain/snapshot/snapshot-engine.js";
import type { RouterOSRestClient } from "../../../../src/adapter/rest-client.js";

const RECORDS = [
  { ".id": "*1", "dst-address": "10.0.0.0/8", "gateway": "192.168.1.1", "routing-table": "main" },
];

function makeClient(records = RECORDS): RouterOSRestClient {
  return {
    get: vi.fn().mockResolvedValue(records),
  } as unknown as RouterOSRestClient;
}

describe("takeSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches records and writes JSON file", async () => {
    const client = makeClient();
    const meta = await takeSnapshot(client, "edge-01", "ip/route", "/tmp/snapshots");

    expect(client.get).toHaveBeenCalledWith("ip/route", {});
    expect(fsp.mkdir).toHaveBeenCalledWith(
      join("/tmp/snapshots", "edge-01"),
      { recursive: true },
    );
    expect(fsp.writeFile).toHaveBeenCalledOnce();
    const written = JSON.parse((fsp.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string);
    expect(written.routerId).toBe("edge-01");
    expect(written.path).toBe("ip/route");
    expect(written.records).toEqual(RECORDS);
  });

  it("returns SnapshotMeta with correct fields", async () => {
    const meta = await takeSnapshot(makeClient(), "edge-01", "ip/route", "/tmp/snapshots");
    expect(meta.routerId).toBe("edge-01");
    expect(meta.path).toBe("ip/route");
    expect(meta.recordCount).toBe(1);
    expect(meta.filePath).toContain("edge-01");
    expect(meta.filePath).toContain("ip-route");
  });
});

describe("loadSnapshot", () => {
  it("parses JSON file and returns records", async () => {
    const stored = { id: "snap1", routerId: "edge-01", path: "ip/route", ts: "2026-01-01T00:00:00Z", records: RECORDS };
    (fsp.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(stored));
    const result = await loadSnapshot("/tmp/snapshots/edge-01/snap1.json");
    expect(result).toEqual(stored);
  });
});

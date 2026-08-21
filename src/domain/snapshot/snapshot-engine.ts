import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { DeviceClient } from "../../adapter/connection-pool.js";
import { SwosClient } from "../../adapter/swos-client.js";
import type { SnapshotMeta, RouterOSRecord } from "../../types.js";
import { normalizeForDiff } from "./diff-engine.js";

function pathToSlug(rosPath: string): string {
  return rosPath.replace(/\//g, "-");
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
}

export interface StoredSnapshot {
  id: string;
  routerId: string;
  path: string;
  ts: string;
  records: RouterOSRecord[];
  /** Present only for SwOS snapshots: the verbatim ".b" blob as the device sent it. */
  blob?: string;
}

async function persist(stored: StoredSnapshot, snapshotDir: string): Promise<SnapshotMeta> {
  const dir = join(snapshotDir, stored.routerId);
  const filePath = join(dir, `${stored.id}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(stored, null, 2));
  return {
    id: stored.id,
    routerId: stored.routerId,
    path: stored.path,
    ts: stored.ts,
    filePath,
    recordCount: stored.records.length,
  };
}

/**
 * Capture the current state of `path` before a write. RouterOS snapshots store
 * normalized records; SwOS snapshots store the raw blob verbatim, because the
 * firmware only accepts whole-blob writes and any re-encoding loses fidelity.
 */
export async function takeSnapshot(
  client: DeviceClient,
  routerId: string,
  path: string,
  snapshotDir: string,
): Promise<SnapshotMeta> {
  const id = `${timestampPrefix()}-${pathToSlug(path)}-${nanoid(6)}`;
  const ts = new Date().toISOString();

  if (client instanceof SwosClient) {
    const blob = await client.getRaw(path);
    return persist({ id, routerId, path, ts, records: [], blob }, snapshotDir);
  }

  // Store the normalized form (dynamic records dropped, runtime fields stripped)
  // so the snapshot contains only restorable configuration.
  const records = normalizeForDiff(await client.get<RouterOSRecord>(path, {}));
  return persist({ id, routerId, path, ts, records }, snapshotDir);
}

export async function loadSnapshot(filePath: string): Promise<StoredSnapshot> {
  return JSON.parse(await readFile(filePath, "utf-8")) as StoredSnapshot;
}

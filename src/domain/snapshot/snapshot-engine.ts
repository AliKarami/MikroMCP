import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { SnapshotMeta, RouterOSRecord } from "../../types.js";
import { normalizeForDiff } from "./diff-engine.js";

function pathToSlug(rosPath: string): string {
  return rosPath.replace(/\//g, "-");
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
}

interface StoredSnapshot {
  id: string;
  routerId: string;
  path: string;
  ts: string;
  records: RouterOSRecord[];
}

export async function takeSnapshot(
  client: RouterOSRestClient,
  routerId: string,
  path: string,
  snapshotDir: string,
): Promise<SnapshotMeta> {
  // Store the normalized form (dynamic records dropped, runtime fields stripped)
  // so the snapshot contains only restorable configuration.
  const records = normalizeForDiff(await client.get<RouterOSRecord>(path, {}));
  const id = `${timestampPrefix()}-${pathToSlug(path)}-${nanoid(6)}`;
  const dir = join(snapshotDir, routerId);
  const filePath = join(dir, `${id}.json`);
  const ts = new Date().toISOString();

  await mkdir(dir, { recursive: true });
  const stored: StoredSnapshot = { id, routerId, path, ts, records };
  await writeFile(filePath, JSON.stringify(stored, null, 2));

  return { id, routerId, path, ts, filePath, recordCount: records.length };
}

export async function loadSnapshot(filePath: string): Promise<StoredSnapshot> {
  return JSON.parse(await readFile(filePath, "utf-8")) as StoredSnapshot;
}

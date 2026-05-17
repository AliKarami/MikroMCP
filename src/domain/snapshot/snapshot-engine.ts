import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { SnapshotMeta, RouterOSRecord } from "../../types.js";

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
  const records = await client.get<RouterOSRecord>(path, {});
  const id = `${timestampPrefix()}-${pathToSlug(path)}-${nanoid(6)}`;
  const dir = join(snapshotDir, routerId);
  const filePath = join(dir, `${id}.json`);
  const ts = new Date().toISOString();

  mkdirSync(dir, { recursive: true });
  const stored: StoredSnapshot = { id, routerId, path, ts, records };
  writeFileSync(filePath, JSON.stringify(stored, null, 2));

  return { id, routerId, path, ts, filePath, recordCount: records.length };
}

export function loadSnapshot(filePath: string): StoredSnapshot {
  return JSON.parse(readFileSync(filePath, "utf-8")) as StoredSnapshot;
}

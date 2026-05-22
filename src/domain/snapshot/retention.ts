import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("snapshot-retention");

/**
 * Delete snapshot files under `snapshotDir` (one sub-directory per router)
 * whose mtime is older than `maxAgeDays`. Returns the number of files removed.
 * Missing directories are treated as empty.
 */
export async function pruneSnapshots(snapshotDir: string, maxAgeDays: number): Promise<number> {
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;

  let routerDirs: string[];
  try {
    routerDirs = await readdir(snapshotDir);
  } catch {
    return 0;
  }

  for (const routerDir of routerDirs) {
    const dirPath = join(snapshotDir, routerDir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.mtimeMs < cutoffMs) {
          await unlink(filePath);
          removed++;
        }
      } catch (err) {
        log.warn({ err, filePath }, "Failed to evaluate snapshot for retention");
      }
    }
  }

  if (removed > 0) {
    log.info({ removed, maxAgeDays }, "Pruned expired snapshots");
  }
  return removed;
}

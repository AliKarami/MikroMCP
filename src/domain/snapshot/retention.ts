import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";
import {
  journalSegmentName,
  journalSegmentPaths,
  journalSegmentRotatedAt,
  parseJournal,
} from "./write-journal.js";

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

/** Rotate the current journal once its oldest entry is this old. */
const JOURNAL_ROTATE_AFTER_MS = 86_400_000;

/**
 * Keep the write journal bounded without ever rewriting a file another server
 * process may be appending to (each stdio client spawns its own, sharing one
 * data directory):
 *
 * - The current file is renamed to a dated segment once its oldest entry is a
 *   day old. An append that opened it before the rename completes into the
 *   segment, which readers still read, so nothing is lost; the next append
 *   starts a new current file.
 * - A segment rotated and last written more than `maxAgeDays` ago is deleted —
 *   the age at which snapshots are pruned, after which none of its entries can
 *   be rolled back. Nothing writes to a segment that old.
 * - Two processes rotating at once can each make a segment; readers dedupe and
 *   sort by timestamp, so that only costs an extra small file.
 *
 * The audit log, not the journal, is the long-term record.
 */
export async function rotateAndPruneJournal(
  journalPath: string,
  maxAgeDays: number,
  now: Date = new Date(),
): Promise<{ rotated: boolean; removed: number }> {
  const cutoffMs = now.getTime() - maxAgeDays * 86_400_000;

  let removed = 0;
  for (const segment of journalSegmentPaths(journalPath)) {
    try {
      // Both clocks must be past the cutoff: the name says when it was rotated,
      // so a just-rotated segment of an idle journal (old mtime) — which an
      // in-flight append may still be finishing into — is never deleted.
      if (journalSegmentRotatedAt(segment) < cutoffMs && (await stat(segment)).mtimeMs < cutoffMs) {
        await unlink(segment);
        removed++;
      }
    } catch (err) {
      // Another process may have pruned it first.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err, segment }, "Failed to prune a write-journal segment");
      }
    }
  }
  if (removed > 0) {
    log.info({ removed, maxAgeDays }, "Pruned expired write-journal segments");
  }

  let rotated = false;
  try {
    const oldest = parseJournal(await readFile(journalPath, "utf-8")).find(
      (e) => typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)),
    );
    if (oldest && Date.parse(oldest.ts as string) <= now.getTime() - JOURNAL_ROTATE_AFTER_MS) {
      await rename(journalPath, journalSegmentName(journalPath, now));
      rotated = true;
    }
  } catch (err) {
    // No journal yet, or another process rotated it first.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ err, journalPath }, "Failed to rotate the write journal");
    }
  }

  return { rotated, removed };
}

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";
import { redactParams } from "../../observability/audit-log.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("write-journal");

interface AttemptArgs {
  journalPath: string;
  identityId: string;
  role: string;
  tool: string;
  routerId: string;
  params: Record<string, unknown>;
  snapshotIds: string[];
  /** The effective dryRun, schema defaults applied — params alone can't tell. */
  dryRun?: boolean;
}

interface OutcomeArgs {
  journalPath: string;
  journalId: string;
  phase: "success" | "failure";
  durationMs: number;
  outcome?: string;
}

async function appendLine(filePath: string, obj: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(obj) + "\n");
  } catch (err) {
    log.error({ err, filePath }, "Failed to write to write journal");
  }
}

export function recordAttempt(args: AttemptArgs): string {
  const id = nanoid();
  void appendLine(args.journalPath, {
    id,
    ts: new Date().toISOString(),
    identityId: args.identityId,
    role: args.role,
    tool: args.tool,
    routerId: args.routerId,
    params: redactParams(args.params),
    snapshotIds: args.snapshotIds,
    ...(args.dryRun ? { dryRun: true } : {}),
    phase: "attempt",
  });
  return id;
}

/**
 * Parse the journal's NDJSON text into entries, skipping blank lines and lines
 * that are not a JSON object — a crash can tear the last line mid-write, and
 * that must not make the rest of the journal unreadable.
 */
export function parseJournal(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        entries.push(entry as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * The journal is a current file plus rotated segments beside it
 * (`write-journal.<stamp>-<suffix>.ndjson`). Rotation renames the current file,
 * so an append still writing to it lands in the segment instead of being lost.
 * The suffix is random, not a PID: containers sharing a data volume can all be
 * PID 1, and a rename onto an existing segment would overwrite it.
 */
const SEGMENT_STAMP = /^\d{8}T\d{6}Z-[0-9a-z]+$/;

export function journalSegmentName(
  journalPath: string,
  now: Date,
  suffix: string = randomBytes(6).toString("hex"),
): string {
  const ext = extname(journalPath);
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return join(dirname(journalPath), `${basename(journalPath, ext)}.${stamp}-${suffix}${ext}`);
}

/** The journal's rotated segments, in name (rotation-time) order. A missing directory has none. */
export function journalSegmentPaths(journalPath: string): string[] {
  const ext = extname(journalPath);
  const prefix = `${basename(journalPath, ext)}.`;
  let names: string[];
  try {
    names = readdirSync(dirname(journalPath));
  } catch {
    return [];
  }
  return names
    .filter(
      (n) =>
        n.startsWith(prefix) &&
        n.endsWith(ext) &&
        SEGMENT_STAMP.test(n.slice(prefix.length, n.length - ext.length)),
    )
    .sort()
    .map((n) => join(dirname(journalPath), n));
}

/** When a segment was rotated, from its name (ms since epoch). */
export function journalSegmentRotatedAt(segmentPath: string): number {
  const stamp = /\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-z]+\.[^.]+$/.exec(
    segmentPath,
  );
  if (!stamp) return NaN;
  const [, y, mo, d, h, mi, se] = stamp;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Every journal entry, oldest first by timestamp. A file that does not exist
 * (no journal yet, or a segment pruned meanwhile) counts as empty; any other
 * read error is thrown.
 *
 * Another process may rotate the journal while this reads. The current file is
 * read before the segments are listed, so entries it moves are either read here
 * or found in the new segment; ones seen twice are kept once. Sorting by `ts`
 * keeps the order right whatever order the files were rotated in.
 */
export function readJournalEntries(journalPath: string): Record<string, unknown>[] {
  const current = parseJournal(readIfExists(journalPath));
  const segments = journalSegmentPaths(journalPath).flatMap((p) => parseJournal(readIfExists(p)));

  const seen = new Set<string>();
  const entries = [...segments, ...current].filter((e) => {
    const key = `${String(e.id)}\u0000${String(e.phase)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const time = (e: Record<string, unknown>) => {
    const t = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return entries
    .map((e, i) => ({ e, i, t: time(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}

export function recordOutcome(args: OutcomeArgs): void {
  void appendLine(args.journalPath, {
    id: args.journalId,
    ts: new Date().toISOString(),
    phase: args.phase,
    outcome: args.outcome,
    durationMs: args.durationMs,
  });
}

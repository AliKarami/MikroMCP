import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
    phase: "attempt",
  });
  return id;
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

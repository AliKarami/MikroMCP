// ---------------------------------------------------------------------------
// MikroMCP - Dead-man-switch auto-revert for writes that can lock out management
// ---------------------------------------------------------------------------
//
// RouterOS Safe Mode belongs to a terminal or Winbox session; the stateless REST
// API has no equivalent. So before a risky write a one-shot /system scheduler job
// is armed that undoes it after N seconds. Once the write is applied, a new REST
// connection proves the router still answers; only then is the job removed. If the
// router stops answering, the job stays and the router reverts itself.

import { nanoid } from "nanoid";
import { z } from "zod";
import type { ToolContext } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("auto-revert");

const SCHEDULER_PATH = "system/scheduler";

export const DEFAULT_AUTO_REVERT_SECONDS = 60;
const MIN_AUTO_REVERT_SECONDS = 30;
const MAX_AUTO_REVERT_SECONDS = 3600;
const PROBE_ATTEMPTS = 2;

/**
 * Waits around the post-change probe. A firewall change can take a moment to bite:
 * with connection tracking on `auto`, RouterOS only starts tracking once a rule
 * needs it, and a probe sent before that slips past a `connection-state=new` drop
 * (seen on a CHR). Mutable so unit tests can run without the waits.
 */
export const probeTiming = { settleMs: 3_000, retryMs: 2_000 };

export const autoRevertSeconds = z
  .number()
  .int()
  .refine(
    (v) => v === 0 || (v >= MIN_AUTO_REVERT_SECONDS && v <= MAX_AUTO_REVERT_SECONDS),
    `Must be 0 (off) or ${MIN_AUTO_REVERT_SECONDS}-${MAX_AUTO_REVERT_SECONDS} seconds`,
  )
  .default(DEFAULT_AUTO_REVERT_SECONDS)
  .describe(
    `Dead-man switch: before the write, arm a RouterOS scheduler job that undoes it after this many seconds; it is removed once the router answers a new REST connection after the change. 0 turns it off. Default ${DEFAULT_AUTO_REVERT_SECONDS}`,
  );

const AMBIGUOUS = new Set<ErrorCategory>([
  ErrorCategory.ROUTER_TIMEOUT,
  ErrorCategory.ROUTER_UNREACHABLE,
]);

/** How to undo one firewall write, expressed so a RouterOS script can do it. */
export type FirewallRevert =
  /** Before an add returns its id: remove any rule in the chain that was not there before. */
  | { kind: "remove-new"; chain: string; knownIds: string[] }
  /** After an add: remove exactly the rule it created. */
  | { kind: "remove-id"; id: string }
  /**
   * After a remove: re-add the rule as it was, at the same position. `sameComment`
   * counts the rules that carried its comment before the remove, itself included.
   */
  | {
      kind: "restore";
      record: Record<string, unknown>;
      placeBefore?: string;
      sameComment: number;
    }
  /** After enable/disable: put the disabled flag back. */
  | { kind: "set-disabled"; id: string; disabled: boolean };

export interface AutoRevertReport {
  status: "disarmed" | "armed" | "expired" | "disarm_failed";
  jobName: string;
  seconds: number;
  revert: FirewallRevert["kind"];
  healthCheck: "ok" | "failed" | "not_run";
}

const ROS_ID = /^\*[0-9A-Fa-f]+$/;

/** Fields RouterOS reports on a firewall rule but does not accept on add. */
const READ_ONLY_FIELDS = new Set(["bytes", "packets", "dynamic", "invalid"]);

/** A RouterOS script string literal. `$` would otherwise interpolate a variable. */
export function rosString(value: string): string {
  const escaped = value
    .replace(/[\\"$?]/g, (c) => `\\${c}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function rosId(id: string): string {
  if (!ROS_ID.test(id)) {
    throw new MikroMCPError({
      category: ErrorCategory.INTERNAL,
      code: "AUTO_REVERT_BAD_ID",
      message: `Cannot build an auto-revert script for RouterOS id "${id}".`,
      recoverability: {
        retryable: false,
        suggestedAction: "Pass autoRevertSeconds=0 to apply without the auto-revert job.",
      },
    });
  }
  return id;
}

function rosValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return rosString(String(value));
}

/** `/ip firewall filter` for `ip/firewall/filter`. */
function menu(path: string): string {
  return `/${path.split("/").join(" ")}`;
}

/** The `add` arguments that recreate a rule as the router reported it. */
export function addArguments(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(
      ([key, value]) =>
        !key.startsWith(".") &&
        !READ_ONLY_FIELDS.has(key) &&
        /^[a-z0-9-]+$/.test(key) &&
        value !== "",
    )
    .map(([key, value]) => `${key}=${rosValue(value)}`)
    .join(" ");
}

function revertBody(path: string, revert: FirewallRevert): string {
  const m = menu(path);
  switch (revert.kind) {
    case "remove-id":
      return `${m} remove [find where .id=${rosId(revert.id)}]`;
    case "set-disabled":
      return `${m} set [find where .id=${rosId(revert.id)}] disabled=${revert.disabled ? "yes" : "no"}`;
    case "remove-new": {
      const known = `,${revert.knownIds.map(rosId).join(",")},`;
      // RouterOS has no "not in" for ids, so look each one up in a delimited string.
      return [
        `:local known ${rosString(known)}`,
        `:foreach i in=[${m} find where chain=${rosString(revert.chain)} and dynamic=no] do={`,
        `:local seen false`,
        `:local p [:find $known ("," . $i . ",")]`,
        `:if ([:typeof $p] = "num") do={:if ($p >= 0) do={:set seen true}}`,
        `:if (!$seen) do={${m} remove $i}`,
        `}`,
      ].join("\n");
    }
    case "restore": {
      const args = addArguments(revert.record);
      const add = `${m} add ${args}`;
      const placed =
        revert.placeBefore === undefined
          ? add
          : `:do {${add} place-before=${rosId(revert.placeBefore)}} on-error={${add}}`;
      const comment = revert.record.comment;
      // Restore only while the comment is one rule short, so a job that fires twice
      // adds nothing the second time, and other rules sharing the comment don't
      // count as the removed one still being there.
      return typeof comment === "string" && comment !== ""
        ? `:if ([:len [${m} find where comment=${rosString(comment)}]] < ${revert.sameComment}) do={\n${placed}\n}`
        : placed;
    }
  }
}

/** The scheduler job's on-event: undo the write, then remove the job itself. */
export function revertScript(
  jobName: string,
  path: string,
  revert: FirewallRevert,
  description: string,
): string {
  const tag = `MikroMCP auto-revert ${jobName}`;
  return [
    `:log warning ${rosString(`${tag}: no confirmation from MikroMCP, reverting ${description}`)}`,
    `:do {`,
    revertBody(path, revert),
    `} on-error={:log error ${rosString(`${tag}: revert failed`)}}`,
    `/system scheduler remove [find where name=${rosString(jobName)}]`,
  ].join("\n");
}

function withReport(err: MikroMCPError, report: AutoRevertReport, note: string): MikroMCPError {
  return new MikroMCPError({
    category: err.category,
    code: err.code,
    message: err.message,
    details: { ...err.details, autoRevert: report },
    recoverability: {
      ...err.recoverability,
      suggestedAction: `${note} ${err.recoverability.suggestedAction}`,
    },
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The router's wall clock plus `seconds`, as scheduler `start-date`/`start-time`
 * in the date format the router reported. A new entry's first run defaults to
 * the moment it is added, so `interval` alone would fire the revert at once.
 * Both clock forms are handled: `2026-11-11` (RouterOS 7.10+) and `nov/11/2026`.
 */
export function startAfter(
  clock: { date?: unknown; time?: unknown },
  seconds: number,
): { "start-date": string; "start-time": string } {
  const date = String(clock.date ?? "");
  const time = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(clock.time ?? ""));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const legacy = /^([a-z]{3})\/(\d{2})\/(\d{4})$/i.exec(date);
  const month = legacy ? MONTHS.indexOf(legacy[1].toLowerCase()) : -1;
  if (!time || (!iso && month < 0)) {
    throw new MikroMCPError({
      category: ErrorCategory.INTERNAL,
      code: "AUTO_REVERT_CLOCK_UNREADABLE",
      message: `Cannot read the router clock ("${date} ${String(clock.time ?? "")}") to schedule the auto-revert job.`,
      recoverability: {
        retryable: false,
        suggestedAction: "Pass autoRevertSeconds=0 to apply without the auto-revert job.",
      },
    });
  }
  // The clock is local wall time; doing the arithmetic in UTC keeps it as such.
  const at = new Date(
    Date.UTC(
      Number(iso ? iso[1] : legacy![3]),
      iso ? Number(iso[2]) - 1 : month,
      Number(iso ? iso[3] : legacy![2]),
      Number(time[1]),
      Number(time[2]),
      Number(time[3]) + seconds,
    ),
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    "start-date": iso
      ? `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
      : `${MONTHS[at.getUTCMonth()]}/${pad(at.getUTCDate())}/${at.getUTCFullYear()}`,
    "start-time": `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`,
  };
}

async function firstRun(
  context: ToolContext,
  seconds: number,
): Promise<{ "start-date": string; "start-time": string }> {
  const results: unknown = await context.routerClient.get<RouterOSRecord>("system/clock");
  const clock = (Array.isArray(results) ? results[0] : results) as
    | Record<string, unknown>
    | undefined;
  return startAfter(clock ?? {}, seconds);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(context: ToolContext, seconds: number): Promise<boolean> {
  await sleep(probeTiming.settleMs);
  const timeoutMs = Math.min(10_000, Math.floor((seconds * 1000) / 4));
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      await context.routerClient.probe(timeoutMs);
      return true;
    } catch (err) {
      log.warn({ err, routerId: context.routerId, attempt }, "Post-change REST probe failed");
      if (attempt < PROBE_ATTEMPTS) await sleep(probeTiming.retryMs);
    }
  }
  return false;
}

export interface GuardOptions {
  seconds: number;
  /** REST path of the table the write touches, e.g. `ip/firewall/filter`. */
  path: string;
  revert: FirewallRevert;
  /** Human-readable summary for the job comment and router log. */
  description: string;
}

/**
 * Run `write` behind an armed auto-revert job. `write` may call `retarget` once it
 * knows more precisely what to undo (an add learns the new rule's id).
 *
 * Resolves only when the router answered after the change and the job was removed.
 * Every other outcome throws, with `details.autoRevert` describing the job.
 */
export async function guardedWrite<T>(
  context: ToolContext,
  options: GuardOptions,
  write: (retarget: (revert: FirewallRevert) => Promise<void>) => Promise<T>,
): Promise<{ result: T; autoRevert: AutoRevertReport }> {
  const { seconds, path, description } = options;
  const jobName = `mikromcp-autorevert-${nanoid(10)}`;
  const report: AutoRevertReport = {
    status: "armed",
    jobName,
    seconds,
    revert: options.revert.kind,
    healthCheck: "not_run",
  };

  let jobId: string;
  try {
    const job = await context.routerClient.create(SCHEDULER_PATH, {
      name: jobName,
      ...(await firstRun(context, seconds)),
      interval: `${seconds}s`,
      policy: "read,write",
      comment: `MikroMCP auto-revert: ${description}`.slice(0, 255),
      "on-event": revertScript(jobName, path, options.revert, description),
    });
    jobId = String(job[".id"]);
  } catch (err) {
    const cause = enrichError(err, { routerId: context.routerId });
    throw new MikroMCPError({
      category: cause.category,
      code: "AUTO_REVERT_ARM_FAILED",
      message: `Could not arm the auto-revert scheduler job, so the change was not applied: ${cause.message}`,
      details: { cause: cause.code },
      recoverability: {
        retryable: cause.recoverability.retryable,
        suggestedAction:
          "Give the REST user write access to /system scheduler, or pass autoRevertSeconds=0 to apply without the safety net.",
      },
    });
  }
  const armedAt = Date.now();
  log.info({ routerId: context.routerId, jobName, seconds }, "Auto-revert job armed");

  const retarget = async (revert: FirewallRevert) => {
    try {
      await context.routerClient.update(SCHEDULER_PATH, jobId, {
        "on-event": revertScript(jobName, path, revert, description),
      });
      report.revert = revert.kind;
    } catch (err) {
      // The job armed before the write still undoes it, only less precisely.
      log.warn({ err, jobName }, "Could not narrow the auto-revert job; keeping the original");
    }
  };

  let result: T;
  try {
    result = await write(retarget);
  } catch (err) {
    const error = enrichError(err, { routerId: context.routerId });
    if (AMBIGUOUS.has(error.category)) {
      throw withReport(
        error,
        report,
        `The auto-revert job "${jobName}" stays armed and undoes the change ${seconds}s after it was armed if it landed.`,
      );
    }
    await context.routerClient
      .remove(SCHEDULER_PATH, jobId)
      .catch((disarmErr: unknown) =>
        log.warn(
          { err: disarmErr, jobName },
          "Could not remove auto-revert job after failed write",
        ),
      );
    throw error;
  }

  if (!(await probe(context, seconds))) {
    report.healthCheck = "failed";
    throw new MikroMCPError({
      category: ErrorCategory.ROUTER_UNREACHABLE,
      code: "AUTO_REVERT_PENDING",
      message: `The change was applied, but the router stopped accepting new REST connections afterwards. The auto-revert job "${jobName}" was left armed and will undo the change within ${seconds}s of being armed.`,
      details: { autoRevert: report },
      recoverability: {
        retryable: false,
        suggestedAction: `Wait ${seconds}s for the router to revert itself, then check list_firewall_rules. Do not retry the same change; it is what cut off access.`,
        alternativeTools: ["list_firewall_rules", "check_router_health"],
      },
    });
  }
  report.healthCheck = "ok";

  try {
    const remaining = await context.routerClient.get<RouterOSRecord>(SCHEDULER_PATH, {
      filter: { name: jobName },
    });
    if (remaining.length === 0) {
      report.status = "expired";
      throw new MikroMCPError({
        category: ErrorCategory.ROUTER_TIMEOUT,
        code: "AUTO_REVERT_EXPIRED",
        message: `The write and health check took longer than autoRevertSeconds (${seconds}s, ${Math.round((Date.now() - armedAt) / 1000)}s elapsed): the auto-revert job "${jobName}" already ran and has likely undone the change.`,
        details: { autoRevert: report },
        recoverability: {
          retryable: true,
          suggestedAction:
            "Check list_firewall_rules, then retry with a larger autoRevertSeconds if the change is gone.",
          alternativeTools: ["list_firewall_rules"],
        },
      });
    }
    await context.routerClient.remove(SCHEDULER_PATH, String(remaining[0][".id"]));
  } catch (err) {
    if (err instanceof MikroMCPError && err.code === "AUTO_REVERT_EXPIRED") throw err;
    report.status = "disarm_failed";
    const cause = enrichError(err, { routerId: context.routerId });
    throw new MikroMCPError({
      category: cause.category,
      code: "AUTO_REVERT_DISARM_FAILED",
      message: `The change was applied and the router still answers, but the auto-revert job "${jobName}" could not be removed: it will undo the change ${seconds}s after it was armed. ${cause.message}`,
      details: { autoRevert: report, cause: cause.code },
      recoverability: {
        retryable: false,
        suggestedAction: `Remove scheduler job "${jobName}" with manage_scheduled_job before it fires, or re-apply the change after it has.`,
        alternativeTools: ["manage_scheduled_job", "list_scheduled_jobs"],
      },
    });
  }

  report.status = "disarmed";
  log.info({ routerId: context.routerId, jobName }, "Auto-revert job disarmed");
  return { result, autoRevert: report };
}

/** One line for a tool's text result. */
export function autoRevertSummary(report: AutoRevertReport): string {
  return `Auto-revert: a ${report.seconds}s scheduler job was armed before the change and removed after the router answered a new REST connection.`;
}

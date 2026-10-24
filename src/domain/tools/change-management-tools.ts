import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isEffectiveDryRun, loggableParams, snapshotPathsFor } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";
import { takeSnapshot, loadSnapshot } from "../snapshot/snapshot-engine.js";
import type { StoredSnapshot } from "../snapshot/snapshot-engine.js";
import { computeRestorePlan, applyRestorePlan } from "../snapshot/diff-engine.js";
import { readJournalEntries, recordAttempt, recordOutcome } from "../snapshot/write-journal.js";
import type { RouterOSRecord } from "../../types.js";
import type { SwosClient } from "../../adapter/swos-client.js";
import { parseWireBlob, presentableBlob } from "../../adapter/swos-protocol.js";
import { unionVlanBlob } from "../swos/switch-config.js";

const log = createLogger("change-management");

const stepSchema = z
  .object({
    tool: z.string().min(1).describe("Name of the MikroMCP tool to invoke"),
    params: z.record(z.unknown()).describe("Tool parameters (dryRun is injected automatically)"),
  })
  .strict();

const planChangesInputSchema = z
  .object({
    routerId,
    steps: z
      .array(stepSchema)
      .min(1)
      .max(10)
      .describe("Ordered list of write operations to preview (up to 10)"),
  })
  .strict();

const applyPlanInputSchema = z
  .object({
    routerId,
    steps: z
      .array(stepSchema)
      .min(1)
      .max(10)
      .describe("Ordered list of write operations to apply in sequence"),
    confirmationToken: z.string().optional(),
  })
  .strict();

/**
 * Whether a journal attempt was a dry run. The executor records the effective
 * value (schema defaults applied); entries written before that carry it only in
 * params, when the caller passed it explicitly.
 */
function journalEntryWasDryRun(entry: Record<string, unknown>): boolean {
  const params = (entry.params ?? {}) as Record<string, unknown>;
  return entry.dryRun === true || params.dryRun === true;
}

const listJournalInputSchema = z
  .object({
    routerId: z.string().optional().describe("Only entries for this router id"),
    tool: z.string().optional().describe("Only entries written by this tool"),
    limit: z.number().int().min(1).max(500).default(20).describe("Max entries to return"),
  })
  .strict();

const listJournalTool: ToolDefinition = {
  name: "list_journal",
  title: "List Write Journal",
  description:
    "List recent entries from the server's write journal (write-journal.ndjson): every journaled write with its journalId, timestamp, tool, router, parameters (as redacted at write time), snapshot ids and outcome — newest first. Read-only. Use it to recover a lost journalId for rollback_change, or to audit what was written when. Only entries with rollbackable: true can be rolled back — dry runs and writes without snapshots (run_command, plan_changes) cannot.",
  inputSchema: listJournalInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  skipRouterContext: true,
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listJournalInputSchema.parse(params);
    const journalPath = context.appConfig.journalPath;
    if (!journalPath) {
      return {
        content: "Write journal is disabled (no journal path configured on this server).",
        structuredContent: { journalEnabled: false, entries: [], total: 0, returned: 0 },
      };
    }

    let journal: Record<string, unknown>[];
    try {
      journal = readJournalEntries(journalPath);
    } catch (err) {
      throw new MikroMCPError({
        category: ErrorCategory.INTERNAL,
        code: "JOURNAL_READ_FAILED",
        message: `Could not read the write journal: ${(err as Error).message}`,
        details: { journalPath },
        recoverability: {
          retryable: false,
          suggestedAction: "Check the file's permissions under the MikroMCP data directory.",
        },
      });
    }

    const outcomes = new Map<string, { phase: string; outcome?: string; durationMs?: number }>();
    const attempts: Record<string, unknown>[] = [];
    for (const entry of journal) {
      if (entry.phase === "attempt") attempts.push(entry);
      else
        outcomes.set(entry.id as string, {
          phase: entry.phase as string,
          outcome: entry.outcome as string | undefined,
          durationMs: entry.durationMs as number | undefined,
        });
    }

    let entries = attempts
      .map((a) => {
        const outcome = outcomes.get(a.id as string);
        const snapshotIds = Array.isArray(a.snapshotIds) ? (a.snapshotIds as string[]) : [];
        const dryRun = journalEntryWasDryRun(a);
        return {
          journalId: a.id,
          ts: a.ts,
          tool: a.tool,
          routerId: a.routerId,
          identityId: a.identityId,
          role: a.role,
          params: a.params ?? {},
          snapshotIds,
          dryRun,
          rollbackable: !dryRun && snapshotIds.length > 0,
          status: outcome ? outcome.phase : "unknown",
          outcomeCode: outcome?.outcome,
          durationMs: outcome?.durationMs,
        };
      })
      .reverse();
    if (parsed.routerId) entries = entries.filter((e) => e.routerId === parsed.routerId);
    if (parsed.tool) entries = entries.filter((e) => e.tool === parsed.tool);
    // Mirror checkAuthz's router scope: a restricted identity must not read
    // other routers' write history (list_routers filters the same way).
    const scope = context.identity.allowedRouters;
    if (scope.length > 0) entries = entries.filter((e) => scope.includes(e.routerId as string));

    const total = entries.length;
    const returned = entries.slice(0, parsed.limit);
    const header =
      total === 0
        ? "Write journal: no entries."
        : `Write journal: ${returned.length} of ${total}, newest first.`;
    const lines = returned.map(
      (e) =>
        `  ${String(e.journalId)} ${String(e.tool)} ${String(e.routerId)} → ${e.status}${e.outcomeCode ? ` (${e.outcomeCode})` : ""}${e.dryRun ? " dry-run" : e.rollbackable ? "" : " not-rollbackable"} [${String(e.ts)}]`,
    );

    return {
      content: total === 0 ? header : [header, ...lines].join("\n"),
      structuredContent: {
        journalEnabled: true,
        entries: returned,
        total,
        returned: returned.length,
        note: "Pass the journalId of an entry with rollbackable: true to rollback_change to restore that write. Dry runs and entries without snapshots (e.g. run_command) cannot be rolled back.",
      },
    };
  },
};

const rollbackChangeInputSchema = z
  .object({
    routerId,
    journalId: z.string().describe("Journal entry ID from write-journal.ndjson to roll back"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Preview the restore plan without applying changes"),
  })
  .strict();

/**
 * The writes that restore SwOS snapshots without stranding a port. When the
 * VLAN table and per-port settings are restored together, the table first
 * grows to hold both the current and the old VLANs, the per-port settings
 * follow, and only then does the old table replace it; sys.b goes last.
 */
export async function swosRestoreSequence(
  client: SwosClient,
  snapshots: { endpoint: string; blob: string }[],
): Promise<{ endpoint: string; blob: string; step?: string }[]> {
  const rank = (ep: string) => ["fwd.b", "link.b", "vlan.b"].indexOf(ep);
  const perPort = snapshots.filter((s) => rank(s.endpoint) >= 0 && s.endpoint !== "vlan.b");
  const vlan = snapshots.find((s) => s.endpoint === "vlan.b");
  const sys = snapshots.filter((s) => s.endpoint === "sys.b");
  const rest = snapshots.filter((s) => rank(s.endpoint) < 0 && s.endpoint !== "sys.b");

  const sequence: { endpoint: string; blob: string; step?: string }[] = [];
  if (vlan && perPort.length > 0) {
    const currentRows = parseWireBlob(await client.getRaw("vlan.b"));
    const targetRows = parseWireBlob(vlan.blob);
    // The union keys rows by `vid`, a full-SwOS key; SwOS Lite's rows are not
    // understood well enough to merge, so there the old table is written as is.
    if (rowsHaveVid(currentRows) && rowsHaveVid(targetRows)) {
      const union = unionVlanBlob(currentRows, targetRows);
      sequence.push({ endpoint: "vlan.b", blob: union, step: "both tables" });
    }
  }
  sequence.push(...perPort.sort((a, b) => rank(a.endpoint) - rank(b.endpoint)));
  if (vlan) sequence.push(vlan);
  sequence.push(...rest, ...sys);
  return sequence;
}

function rowsHaveVid(rows: unknown): boolean {
  return (
    Array.isArray(rows) &&
    rows.every((row) => row && typeof row === "object" && "vid" in (row as object))
  );
}

/**
 * Undo a SwOS write by re-POSTing the exact blob the device sent before it.
 * There is no diff step: the firmware only accepts whole-blob writes, so the
 * verbatim capture *is* the restore plan.
 */
export async function restoreSwosBlobs(
  snapshots: StoredSnapshot[],
  journalId: string,
  dryRun: boolean,
  context: ToolContext,
): Promise<ToolResult> {
  const client = context.swosClient;
  if (!client) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "PLATFORM_MISMATCH",
      message: `Journal entry "${journalId}" holds SwOS blob snapshots, but router "${context.routerId}" is not a SwOS switch.`,
      recoverability: {
        retryable: false,
        suggestedAction: "Roll back against the switch the write was made on.",
      },
    });
  }

  const snapshotted = snapshots.map((s) => ({ endpoint: s.path, blob: s.blob! }));
  const targets = await swosRestoreSequence(client, snapshotted);
  const shown = targets.map((t) => ({ ...t, blob: presentableBlob(t.endpoint, t.blob) }));

  if (dryRun) {
    return {
      content:
        `Rollback dry run for journal entry "${journalId}": would restore ` +
        `${snapshotted.length} SwOS endpoint(s) in ${targets.length} write(s).\n` +
        shown.map((t) => `  ${t.endpoint}${t.step ? ` (${t.step})` : ""}:\n${t.blob}`).join("\n"),
      structuredContent: { action: "dry_run", journalId, targets: shown },
    };
  }

  // A lost reply partway through leaves the switch between the two states;
  // report every step so the operator knows what still has to be restored.
  const written: string[] = [];
  const labelOf = (t: { endpoint: string; step?: string }) =>
    t.step ? `${t.endpoint} (${t.step})` : t.endpoint;
  for (const [index, target] of targets.entries()) {
    try {
      await client.postRaw(target.endpoint, target.blob);
      written.push(labelOf(target));
    } catch (err) {
      const cause = err instanceof MikroMCPError ? err : undefined;
      const maybe = cause?.category === ErrorCategory.ROUTER_TIMEOUT;
      const pending = targets.slice(index + 1).map(labelOf);
      throw new MikroMCPError({
        category: cause?.category ?? ErrorCategory.INTERNAL,
        code: "SWOS_ROLLBACK_INCOMPLETE",
        message:
          `Rolling back journal entry "${journalId}" failed at ${labelOf(target)} after ` +
          `${written.length} write(s) (${written.join(", ") || "none"})` +
          `${maybe ? "; that write may still have been applied" : ""}; still to restore: ${pending.join(", ") || "none"}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        details: {
          journalId,
          written,
          failedAt: labelOf(target),
          pending,
          ...(maybe ? { possiblyWritten: labelOf(target) } : {}),
          ...(cause ? { cause: cause.code } : {}),
        },
        recoverability: {
          retryable: false,
          suggestedAction:
            "Check the switch with get_swos_config, then run rollback_change again once it answers; it restores the snapshots from the start.",
        },
      });
    }
  }

  return {
    content: `Rolled back journal entry "${journalId}": restored ${snapshotted.map((t) => t.endpoint).join(", ")}.`,
    structuredContent: { action: "rolled_back", journalId, targets: shown },
  };
}

export function createChangeManagementTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const toolMap = new Map(baseTools.map((t) => [t.name, t]));

  // A plan's steps as their own tools would log them: a step can carry a secret
  // its tool redacts (a switch config), and these tools call handlers directly.
  function loggableSteps(params: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(params.steps)) return params;
    return {
      ...params,
      steps: params.steps.map((step: unknown) => {
        const { tool: name, params: stepParams } = (step ?? {}) as Record<string, unknown>;
        const tool = typeof name === "string" ? toolMap.get(name) : undefined;
        return tool && stepParams && typeof stepParams === "object"
          ? {
              ...(step as object),
              params: loggableParams(tool, stepParams as Record<string, unknown>),
            }
          : step;
      }),
    };
  }

  function requireTool(name: string): ToolDefinition {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new MikroMCPError({
        category: ErrorCategory.NOT_FOUND,
        code: "TOOL_NOT_FOUND",
        message: `Tool "${name}" not found. Available tools: ${[...toolMap.keys()].join(", ")}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Check the tool name and try again.",
        },
      });
    }
    return tool;
  }

  const planChangesTool: ToolDefinition = {
    name: "plan_changes",
    title: "Plan Changes",
    description:
      "Preview a sequence of write operations: each step runs with dryRun=true against live state, returning affected paths and the predicted action per step. Use apply_plan to execute the same steps for real.",
    inputSchema: planChangesInputSchema,
    redactParams: loggableSteps,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const parsed = planChangesInputSchema.parse(params);
      log.info({ routerId: context.routerId, stepCount: parsed.steps.length }, "Planning changes");

      const stepResults = [];

      for (const [i, step] of parsed.steps.entries()) {
        const tool = requireTool(step.tool);

        const currentState: Record<string, unknown[]> = {};
        for (const path of snapshotPathsFor(tool, { ...step.params, routerId: parsed.routerId })) {
          try {
            currentState[path] = await context.routerClient.get(path, {});
          } catch {
            currentState[path] = [];
          }
        }

        const dryRunParams = { ...step.params, routerId: parsed.routerId, dryRun: true };
        let dryRunResult: ToolResult;
        try {
          dryRunResult = await tool.handler(dryRunParams, context);
        } catch (err) {
          const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: step.tool });
          dryRunResult = {
            content: `Step ${i + 1} (${step.tool}): would fail — ${error.message}`,
            structuredContent: { action: "would_fail", error: error.code },
            isError: true,
          };
        }

        stepResults.push({
          stepIndex: i,
          tool: step.tool,
          params: step.params,
          currentState,
          dryRunResult: dryRunResult.content,
          structuredDryRun: dryRunResult.structuredContent,
        });
      }

      return {
        content:
          `Plan for ${parsed.steps.length} step(s) on ${parsed.routerId}:\n` +
          stepResults
            .map((s) => `  Step ${s.stepIndex + 1} (${s.tool}): ${s.dryRunResult}`)
            .join("\n"),
        structuredContent: { routerId: parsed.routerId, steps: stepResults },
      };
    },
  };

  const applyPlanTool: ToolDefinition = {
    name: "apply_plan",
    title: "Apply Plan",
    description:
      "Execute write operations in order, stopping on first failure. Each step is snapshotted and journaled individually. Non-admin identities need a confirmationToken (same two-step flow as other destructive tools). Undo individual steps via rollback_change with the returned journal IDs.",
    inputSchema: applyPlanInputSchema,
    redactParams: loggableSteps,
    snapshotPaths: [],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const parsed = applyPlanInputSchema.parse(params);
      log.info({ routerId: context.routerId, stepCount: parsed.steps.length }, "Applying plan");

      const journalPath = context.appConfig.journalPath;
      const snapshotDir = context.appConfig.snapshotDir;

      const results = [];

      for (const [i, step] of parsed.steps.entries()) {
        const tool = requireTool(step.tool);
        const stepParams = { ...step.params, routerId: parsed.routerId };

        const snapshotIds: string[] = [];
        const snapshots = { taken: [] as string[], failed: [] as string[] };
        for (const path of snapshotPathsFor(tool, stepParams)) {
          try {
            const meta = await takeSnapshot(
              context.deviceClient,
              context.routerId,
              path,
              snapshotDir,
            );
            snapshotIds.push(meta.id);
            snapshots.taken.push(path);
          } catch (err) {
            snapshots.failed.push(path);
            log.warn(
              { err, path, routerId: context.routerId, step: i },
              "apply_plan step snapshot failed — proceeding without snapshot",
            );
          }
        }

        const stepJournalId = recordAttempt({
          journalPath,
          identityId: context.identity.id,
          role: context.identity.role,
          tool: step.tool,
          routerId: context.routerId,
          params: loggableParams(tool, stepParams),
          snapshotIds,
          dryRun: isEffectiveDryRun(tool, stepParams),
        });
        const stepStartMs = Date.now();

        try {
          const runStep = () => tool.handler(stepParams, { ...context, snapshots });
          const result = context.circuitBreaker
            ? await context.circuitBreaker.execute(runStep)
            : await runStep();
          recordOutcome({
            journalPath,
            journalId: stepJournalId,
            phase: "success",
            durationMs: Date.now() - stepStartMs,
          });
          results.push({
            stepIndex: i,
            tool: step.tool,
            status: "success",
            journalId: stepJournalId,
            result: result.content,
          });
        } catch (err) {
          const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: step.tool });
          recordOutcome({
            journalPath,
            journalId: stepJournalId,
            phase: "failure",
            outcome: error.code,
            durationMs: Date.now() - stepStartMs,
          });
          log.error({ err: error, tool: step.tool, step: i }, "apply_plan step failed");
          return {
            content: `Apply failed at step ${i + 1}/${parsed.steps.length} (${step.tool}): ${error.message}. ${i} step(s) completed before failure.`,
            structuredContent: {
              status: "failed",
              failedStep: i,
              completedSteps: results,
              error: { code: error.code, message: error.message },
            },
            isError: true,
          };
        }
      }

      return {
        content: `Applied ${parsed.steps.length}/${parsed.steps.length} step(s) on ${parsed.routerId} successfully.`,
        structuredContent: {
          status: "success",
          routerId: parsed.routerId,
          steps: results,
          note: "Each step has its own journalId — pass it to rollback_change to undo that step individually.",
        },
      };
    },
  };

  function findJournalEntry(
    journalPath: string,
    journalId: string,
  ): { snapshotIds: string[]; dryRun: boolean } {
    const entry = readJournalEntries(journalPath).find(
      (e) => e.id === journalId && e.phase === "attempt",
    );
    if (!entry) {
      throw new MikroMCPError({
        category: ErrorCategory.NOT_FOUND,
        code: "JOURNAL_ENTRY_NOT_FOUND",
        message: `Journal entry "${journalId}" not found in write journal.`,
        recoverability: {
          retryable: false,
          suggestedAction:
            "Check the journalId. Only writes recorded in the write journal under MIKROMCP_DATA_DIR can be rolled back.",
        },
      });
    }
    return {
      snapshotIds: (entry.snapshotIds as string[]) ?? [],
      dryRun: journalEntryWasDryRun(entry),
    };
  }

  const rollbackChangeTool: ToolDefinition = {
    name: "rollback_change",
    title: "Rollback Change",
    description:
      "Restore device state to before a write, identified by its journal ID. RouterOS: reads the before-snapshot, diffs against live state, and applies the reverse. SwOS: re-POSTs the exact pre-write '.b' blob. Use dryRun=true to preview. Requires MIKROMCP_DATA_DIR (defaults to data/).",
    inputSchema: rollbackChangeInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    platform: "any",
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const parsed = rollbackChangeInputSchema.parse(params);
      const journalPath = context.appConfig.journalPath;
      const snapshotDir = context.appConfig.snapshotDir;

      log.info({ routerId: context.routerId, journalId: parsed.journalId }, "Rolling back change");

      const { snapshotIds, dryRun: entryWasDryRun } = findJournalEntry(
        journalPath,
        parsed.journalId,
      );

      // A dry run changed nothing, but its snapshot is real: restoring it would
      // undo whatever was written after the preview.
      if (entryWasDryRun) {
        return {
          content: `Journal entry "${parsed.journalId}" was a dry run — nothing was changed, so there is nothing to roll back.`,
          structuredContent: { action: "dry_run_entry", journalId: parsed.journalId },
        };
      }

      if (snapshotIds.length === 0) {
        return {
          content: `Journal entry "${parsed.journalId}" has no associated snapshots — cannot rollback automatically.`,
          structuredContent: { action: "no_snapshot", journalId: parsed.journalId },
        };
      }

      const snapshots = await Promise.all(
        snapshotIds.map((snapshotId) =>
          loadSnapshot(`${snapshotDir}/${context.routerId}/${snapshotId}.json`),
        ),
      );

      const swosSnapshots = snapshots.filter((s) => s.blob !== undefined);
      if (swosSnapshots.length > 0) {
        return restoreSwosBlobs(swosSnapshots, parsed.journalId, parsed.dryRun, context);
      }

      const restorePlans = [];

      for (const stored of snapshots) {
        const current = await context.routerClient.get<RouterOSRecord>(stored.path, {});
        const plan = computeRestorePlan(stored.path, stored.records, current);
        restorePlans.push(plan);
      }

      const totalOps = restorePlans.reduce(
        (sum, p) =>
          sum + p.toCreate.length + p.toRemove.length + p.toUpdate.length + (p.toSet ? 1 : 0),
        0,
      );
      const warnings = restorePlans.flatMap((p) => p.warnings);
      const warningSuffix =
        warnings.length > 0 ? `\nWarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "";

      if (parsed.dryRun) {
        return {
          content: `Rollback dry run for journal entry "${parsed.journalId}": ${totalOps} operation(s) would be applied across ${restorePlans.length} path(s).${warningSuffix}`,
          structuredContent: {
            action: "dry_run",
            journalId: parsed.journalId,
            restorePlans,
            warnings,
          },
        };
      }

      for (const plan of restorePlans) {
        await applyRestorePlan(plan, context.routerClient);
      }

      return {
        content: `Rolled back journal entry "${parsed.journalId}": ${totalOps} operation(s) applied across ${restorePlans.length} path(s).${warningSuffix}`,
        structuredContent: {
          action: "rolled_back",
          journalId: parsed.journalId,
          restorePlans,
          warnings,
        },
      };
    },
  };

  return [planChangesTool, applyPlanTool, rollbackChangeTool, listJournalTool];
}

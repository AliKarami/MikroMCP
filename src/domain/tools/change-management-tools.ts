import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { snapshotPathsFor } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";
import { takeSnapshot, loadSnapshot } from "../snapshot/snapshot-engine.js";
import type { StoredSnapshot } from "../snapshot/snapshot-engine.js";
import { computeRestorePlan, applyRestorePlan } from "../snapshot/diff-engine.js";
import { recordAttempt, recordOutcome } from "../snapshot/write-journal.js";
import type { RouterOSRecord } from "../../types.js";

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
 * Undo a SwOS write by re-POSTing the exact blob the device sent before it.
 * There is no diff step: the firmware only accepts whole-blob writes, so the
 * verbatim capture *is* the restore plan.
 */
async function restoreSwosBlobs(
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

  const targets = snapshots.map((s) => ({ endpoint: s.path, blob: s.blob! }));

  if (dryRun) {
    return {
      content:
        `Rollback dry run for journal entry "${journalId}": would restore ` +
        `${targets.length} SwOS endpoint(s).\n` +
        targets.map((t) => `  ${t.endpoint}:\n${t.blob}`).join("\n"),
      structuredContent: { action: "dry_run", journalId, targets },
    };
  }

  for (const target of targets) {
    await client.postRaw(target.endpoint, target.blob);
  }

  return {
    content: `Rolled back journal entry "${journalId}": restored ${targets.map((t) => t.endpoint).join(", ")}.`,
    structuredContent: { action: "rolled_back", journalId, targets },
  };
}

export function createChangeManagementTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const toolMap = new Map(baseTools.map((t) => [t.name, t]));

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
        for (const path of snapshotPathsFor(tool, stepParams)) {
          try {
            const meta = await takeSnapshot(
              context.deviceClient,
              context.routerId,
              path,
              snapshotDir,
            );
            snapshotIds.push(meta.id);
          } catch (err) {
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
          params: stepParams,
          snapshotIds,
        });
        const stepStartMs = Date.now();

        try {
          const runStep = () => tool.handler(stepParams, context);
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

  function findJournalEntry(journalPath: string, journalId: string): { snapshotIds: string[] } {
    const raw = readFileSync(journalPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const entry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.id === journalId && e.phase === "attempt");
    if (!entry) {
      throw new MikroMCPError({
        category: ErrorCategory.NOT_FOUND,
        code: "JOURNAL_ENTRY_NOT_FOUND",
        message: `Journal entry "${journalId}" not found in write journal.`,
        recoverability: {
          retryable: false,
          suggestedAction:
            "Check the journalId. Only writes recorded since MIKROMCP_JOURNAL_PATH was configured are available.",
        },
      });
    }
    return { snapshotIds: (entry.snapshotIds as string[]) ?? [] };
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

      const { snapshotIds } = findJournalEntry(journalPath, parsed.journalId);

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
        (sum, p) => sum + p.toCreate.length + p.toRemove.length + p.toUpdate.length,
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

  return [planChangesTool, applyPlanTool, rollbackChangeTool];
}

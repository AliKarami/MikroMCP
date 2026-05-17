import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("change-management");

const stepSchema = z
  .object({
    tool: z.string().min(1).describe("Name of the MikroMCP tool to invoke"),
    params: z.record(z.unknown()).describe("Tool parameters (dryRun is injected automatically)"),
  })
  .strict();

const planChangesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier"),
    steps: z
      .array(stepSchema)
      .min(1)
      .max(10)
      .describe("Ordered list of write operations to preview (up to 10)"),
  })
  .strict();

const applyPlanInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier"),
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
    routerId: z.string().describe("Target router identifier"),
    journalId: z.string().describe("Journal entry ID from write-journal.ndjson to roll back"),
    dryRun: z.boolean().default(false).describe("Preview the restore plan without applying changes"),
  })
  .strict();

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
      "Preview a sequence of write operations without applying them. Each step is run with dryRun=true against the live router state. Returns the current state of affected RouterOS paths plus the predicted action for each step. Use apply_plan to execute the same steps for real.",
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
        for (const path of tool.snapshotPaths ?? []) {
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
        content: `Plan for ${parsed.steps.length} step(s) on ${parsed.routerId}:\n` +
          stepResults.map((s) => `  Step ${s.stepIndex + 1} (${s.tool}): ${s.dryRunResult}`).join("\n"),
        structuredContent: { routerId: parsed.routerId, steps: stepResults },
      };
    },
  };

  const applyPlanTool: ToolDefinition = {
    name: "apply_plan",
    title: "Apply Plan",
    description:
      "Execute a sequence of write operations in order. Stops on the first failure. Each step is snapshotted and journaled individually. Requires a confirmationToken for non-admin identities (same two-step flow as other destructive tools). Use rollback_change with any resulting journal IDs to undo individual steps.",
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

      const results = [];

      for (const [i, step] of parsed.steps.entries()) {
        const tool = requireTool(step.tool);
        const stepParams = { ...step.params, routerId: parsed.routerId };

        try {
          const result = await tool.handler(stepParams, context);
          results.push({ stepIndex: i, tool: step.tool, status: "success", result: result.content });
        } catch (err) {
          const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: step.tool });
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
        structuredContent: { status: "success", routerId: parsed.routerId, steps: results },
      };
    },
  };

  // rollback_change added in Task 12
  return [planChangesTool, applyPlanTool];
}

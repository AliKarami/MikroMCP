import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("queue-tools");

const listQueuesInputSchema = z
  .object({
    routerId,
    target: z.string().optional().describe("Filter by target address (substring match)"),
    limit,
  })
  .strict();

const listQueuesTool: ToolDefinition = {
  name: "list_queues",
  title: "List Queues",
  description: "List simple queues on a MikroTik router.",
  inputSchema: listQueuesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listQueuesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing queues");
    try {
      const allQueues = await context.routerClient.get<RouterOSRecord>("queue/simple", {
        limit: undefined,
        offset: undefined,
      });

      const filtered = parsed.target
        ? (allQueues as Record<string, string>[]).filter((q) =>
            (q.target ?? "").includes(parsed.target!),
          )
        : (allQueues as Record<string, string>[]);
      const queues = filtered.slice(0, parsed.limit);

      return {
        content: listContent(
          "Queues",
          context.routerId,
          queues,
          allQueues.length,
          0,
          (q) => compactFields(q, ["name", "target", "max-limit", "limit-at", "disabled", "comment"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          queues,
          total: allQueues.length,
          returned: queues.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_queues");
    }
  },
};

const manageQueueInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Queue name — idempotency key"),
    target: z.string().optional().describe("Target address (required for add; e.g. '192.168.1.0/24')"),
    maxLimit: z.string().optional().describe("Max upload/download limit (e.g. '10M/10M')"),
    limitAt: z.string().optional().describe("Guaranteed rate (e.g. '1M/1M')"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageQueueTool: ToolDefinition = {
  name: "manage_queue",
  title: "Manage Queue",
  description:
    "Add, remove, enable, or disable a simple queue. Idempotent by name: add returns already_exists if a queue with the same name and target already exists.",
  inputSchema: manageQueueInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["queue/simple"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageQueueInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing queue",
    );
    try {
      const allQueues = await context.routerClient.get<RouterOSRecord>("queue/simple", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allQueues as Record<string, string>[]).find((q) => q.name === parsed.name);

      if (parsed.action === "add") {
        if (existing) {
          if (existing.target === parsed.target) {
            return {
              content: `Queue "${parsed.name}" already exists with the same target. No changes made.`,
              structuredContent: { action: "already_exists", queue: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "QUEUE_TARGET_CONFLICT",
            message: `Queue "${parsed.name}" exists with a different target.`,
            details: { existing: existing.target, requested: parsed.target },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing queue first or use a different name.",
              alternativeTools: ["manage_queue"],
            },
          });
        }

        if (!parsed.target) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "QUEUE_TARGET_REQUIRED",
            message: "target is required when adding a queue.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the target address (e.g. '192.168.1.0/24').",
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "target", before: null, after: parsed.target ?? null },
            ...(parsed.maxLimit
              ? [{ property: "max-limit", before: null, after: parsed.maxLimit }]
              : []),
            ...(parsed.limitAt
              ? [{ property: "limit-at", before: null, after: parsed.limitAt }]
              : []),
          ];
          return {
            content: `Dry run: Would add queue "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          target: parsed.target,
        };
        if (parsed.maxLimit) body["max-limit"] = parsed.maxLimit;
        if (parsed.limitAt) body["limit-at"] = parsed.limitAt;
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("queue/simple", body);
        log.info({ name: parsed.name, id: created[".id"] }, "Queue added");
        return {
          content: `Added queue "${parsed.name}".`,
          structuredContent: { action: "created", queue: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Queue "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove queue "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("queue/simple", existing[".id"]);
        log.info({ name: parsed.name }, "Queue removed");
        return {
          content: `Removed queue "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "QUEUE_NOT_FOUND",
          message: `Queue "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the queue name with list_queues.",
            alternativeTools: ["list_queues"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} queue "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [
              {
                property: "disabled",
                before: existing.disabled,
                after: parsed.action === "disable" ? "true" : "false",
              },
            ],
          },
        };
      }

      const disabledValue = parsed.action === "disable" ? "true" : "false";
      await context.routerClient.update("queue/simple", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "Queue updated");
      return {
        content: `Queue "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_queue");
    }
  },
};

export const queueTools: ToolDefinition[] = [listQueuesTool, manageQueueTool];

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("scheduler-tools");

const SCHEDULER_PATH = "system/scheduler";

const listScheduledJobsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by job name (exact match)"),
  })
  .strict();

const listScheduledJobsTool: ToolDefinition = {
  name: "list_scheduled_jobs",
  title: "List Scheduled Jobs",
  description:
    "List RouterOS scheduler entries on a MikroTik router with next-run time, interval, and disabled state.",
  inputSchema: listScheduledJobsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listScheduledJobsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing scheduled jobs");

    try {
      let jobs = await context.routerClient.get<RouterOSRecord>(SCHEDULER_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.name !== undefined) {
        jobs = jobs.filter((j) => (j as Record<string, string>).name === parsed.name);
      }

      return {
        content: `Scheduled jobs on ${context.routerId}: ${jobs.length} job(s).`,
        structuredContent: { routerId: context.routerId, jobs, total: jobs.length },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_scheduled_jobs" });
    }
  },
};

const manageScheduledJobInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "update", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Job name — idempotency key"),
    onEvent: z
      .string()
      .optional()
      .describe("Script name or inline command to run (required on add)"),
    startDate: z.string().optional().describe("Start date (e.g. jan/01/2000)"),
    startTime: z.string().optional().describe("Start time (e.g. 00:00:00)"),
    interval: z.string().optional().describe("Run interval (e.g. 00:05:00 for every 5 minutes)"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageScheduledJobTool: ToolDefinition = {
  name: "manage_scheduled_job",
  title: "Manage Scheduled Job",
  description:
    "Add, update, remove, enable, or disable a RouterOS scheduler entry. Idempotent by name. add throws CONFLICT if name exists; update throws NOT_FOUND if it does not. Supports dry-run.",
  inputSchema: manageScheduledJobInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageScheduledJobInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing scheduled job",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(SCHEDULER_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = all.find((j) => (j as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (parsed.action === "add") {
        if (parsed.onEvent === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "ON_EVENT_REQUIRED",
            message: "onEvent is required when action is add",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the script name or command in the onEvent field.",
            },
          });
        }

        if (existing) {
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "JOB_CONFLICT",
            message: `Scheduled job "${parsed.name}" already exists. Use action=update to modify it.`,
            details: { existing: { name: existing.name, ".id": existing[".id"] } },
            recoverability: {
              retryable: false,
              suggestedAction: "Use action=update to change job settings, or remove and re-add.",
              alternativeTools: ["manage_scheduled_job with action=update"],
            },
          });
        }

        const body: Record<string, string> = {
          name: parsed.name,
          "on-event": parsed.onEvent,
        };
        if (parsed.startDate !== undefined) body["start-date"] = parsed.startDate;
        if (parsed.startTime !== undefined) body["start-time"] = parsed.startTime;
        if (parsed.interval !== undefined) body.interval = parsed.interval;
        if (parsed.comment !== undefined) body.comment = parsed.comment;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add scheduled job "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(SCHEDULER_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "Scheduled job added");
        return {
          content: `Added scheduled job "${parsed.name}".`,
          structuredContent: { action: "created", job: created },
        };
      }

      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "JOB_NOT_FOUND",
            message: `Scheduled job "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the name with list_scheduled_jobs or use action=add.",
              alternativeTools: ["list_scheduled_jobs", "manage_scheduled_job with action=add"],
            },
          });
        }

        const id = existing[".id"];
        const body: Record<string, string> = {};
        if (parsed.onEvent !== undefined) body["on-event"] = parsed.onEvent;
        if (parsed.startDate !== undefined) body["start-date"] = parsed.startDate;
        if (parsed.startTime !== undefined) body["start-time"] = parsed.startTime;
        if (parsed.interval !== undefined) body.interval = parsed.interval;
        if (parsed.comment !== undefined) body.comment = parsed.comment;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: existing[property] ?? null,
            after,
          }));
          return {
            content: `Dry run: Would update scheduled job "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(SCHEDULER_PATH, id, body);
        log.info({ name: parsed.name, id }, "Scheduled job updated");
        return {
          content: `Updated scheduled job "${parsed.name}".`,
          structuredContent: { action: "updated", name: parsed.name, id },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Scheduled job "${parsed.name}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", name: parsed.name },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove scheduled job "${parsed.name}".`,
            structuredContent: { action: "dry_run", id, name: parsed.name },
          };
        }

        await context.routerClient.remove(SCHEDULER_PATH, id);
        log.info({ name: parsed.name, id }, "Scheduled job removed");
        return {
          content: `Removed scheduled job "${parsed.name}".`,
          structuredContent: { action: "removed", id, name: parsed.name },
        };
      }

      if (parsed.action === "enable" || parsed.action === "disable") {
        const wantDisabled = parsed.action === "disable";

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "JOB_NOT_FOUND",
            message: `Scheduled job "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the name with list_scheduled_jobs.",
              alternativeTools: ["list_scheduled_jobs"],
            },
          });
        }

        const id = existing[".id"];
        const isDisabled = existing.disabled === "true";

        if (isDisabled === wantDisabled) {
          return {
            content: `Scheduled job "${parsed.name}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, name: parsed.name },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            {
              property: "disabled",
              before: String(isDisabled),
              after: String(wantDisabled),
            },
          ];
          return {
            content: `Dry run: Would ${parsed.action} scheduled job "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(SCHEDULER_PATH, id, {
          disabled: wantDisabled ? "true" : "false",
        });
        log.info({ name: parsed.name, id, action: parsed.action }, "Scheduled job toggled");
        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} scheduled job "${parsed.name}".`,
          structuredContent: { action: "updated", id, name: parsed.name },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, update, remove, enable, disable.",
        },
      });
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_scheduled_job" });
    }
  },
};

export const schedulerTools: ToolDefinition[] = [listScheduledJobsTool, manageScheduledJobTool];

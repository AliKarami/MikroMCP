import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("log-tools");

const LOG_RULES_PATH = "system/logging";
const LOG_ACTIONS_PATH = "system/logging/action";

const logActionTypeEnum = z.enum(["memory", "disk", "remote", "echo", "email"]);

const listLogRulesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    topics: z.string().optional().describe("Filter by topics (substring match)"),
    logAction: z
      .string()
      .optional()
      .describe("Filter by log action target (exact match on action field)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of rules to return (1-500, default 100)"),
  })
  .strict();

const listLogRulesTool: ToolDefinition = {
  name: "list_log_rules",
  title: "List Log Rules",
  description:
    "List RouterOS logging rules (system/logging) with optional topic substring and action exact-match filtering.",
  inputSchema: listLogRulesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listLogRulesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing log rules");

    try {
      const all = await context.routerClient.get<RouterOSRecord>(LOG_RULES_PATH, {
        limit: undefined,
        offset: undefined,
      });

      let rules = all as Record<string, string>[];

      if (parsed.topics !== undefined) {
        rules = rules.filter((r) => r.topics?.includes(parsed.topics!));
      }

      if (parsed.logAction !== undefined) {
        rules = rules.filter((r) => r.action === parsed.logAction);
      }

      const returned = rules.slice(0, parsed.limit);

      return {
        content: `Log rules on ${context.routerId}: ${returned.length} rule(s) (${all.length} total).`,
        structuredContent: {
          routerId: context.routerId,
          rules: returned,
          total: all.length,
          returned: returned.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_log_rules");
    }
  },
};

const manageLogRuleInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    topics: z.string().describe("Log topics (e.g. firewall, system, info) — idempotency key"),
    logAction: z
      .string()
      .describe("Log action target name (RouterOS action field) — idempotency key"),
    prefix: z.string().optional().describe("Optional prefix to prepend to log messages"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageLogRuleTool: ToolDefinition = {
  name: "manage_log_rule",
  title: "Manage Log Rule",
  description:
    "Add, remove, enable, or disable a RouterOS logging rule. Idempotent by topics+logAction pair. " +
    "add returns already_exists if matching rule found. remove returns not_found gracefully. " +
    "enable/disable throw NOT_FOUND if rule not found. Supports dry-run.",
  inputSchema: manageLogRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["system/logging"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageLogRuleInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, topics: parsed.topics },
      "Managing log rule",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(LOG_RULES_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find(
        (r) => r.topics === parsed.topics && r.action === parsed.logAction,
      );

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `Log rule for topics "${parsed.topics}" → "${parsed.logAction}" already exists.`,
            structuredContent: {
              action: "already_exists",
              routerId: context.routerId,
              id: existing[".id"],
            },
          };
        }

        const body: Record<string, string> = {
          topics: parsed.topics,
          action: parsed.logAction,
        };
        if (parsed.prefix !== undefined) body.prefix = parsed.prefix;

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
            structuredContent: {
              action: "dry_run",
              diff: Object.entries(body).map(([property, after]) => ({
                property,
                before: null,
                after,
              })),
            },
          };
        }

        const created = await context.routerClient.create(LOG_RULES_PATH, body);
        log.info({ topics: parsed.topics, logAction: parsed.logAction, id: created[".id"] }, "Log rule added");
        return {
          content: `Added log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
          structuredContent: {
            action: "created",
            routerId: context.routerId,
            id: created[".id"],
          },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Log rule for topics "${parsed.topics}" → "${parsed.logAction}" not found. No changes made.`,
            structuredContent: {
              action: "not_found",
              routerId: context.routerId,
            },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
            structuredContent: { action: "dry_run", id },
          };
        }

        await context.routerClient.remove(LOG_RULES_PATH, id);
        log.info({ topics: parsed.topics, logAction: parsed.logAction, id }, "Log rule removed");
        return {
          content: `Removed log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
          structuredContent: { action: "removed", id },
        };
      }

      if (parsed.action === "enable" || parsed.action === "disable") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "LOG_RULE_NOT_FOUND",
            message: `Log rule with topics "${parsed.topics}" and action "${parsed.logAction}" not found.`,
            details: { topics: parsed.topics, logAction: parsed.logAction },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify with list_log_rules or use action=add to create it.",
              alternativeTools: ["list_log_rules", "manage_log_rule with action=add"],
            },
          });
        }

        const id = existing[".id"];
        const wantDisabled = parsed.action === "disable";

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would ${parsed.action} log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
            structuredContent: {
              action: "dry_run",
              id,
              diff: [{ property: "disabled", before: existing.disabled ?? "false", after: String(wantDisabled) }],
            },
          };
        }

        await context.routerClient.update(LOG_RULES_PATH, id, {
          disabled: wantDisabled ? "true" : "false",
        });
        const resultAction = wantDisabled ? "disabled" : "enabled";
        log.info({ topics: parsed.topics, id, action: resultAction }, "Log rule toggled");
        return {
          content: `${wantDisabled ? "Disabled" : "Enabled"} log rule topics="${parsed.topics}" action="${parsed.logAction}".`,
          structuredContent: { action: resultAction, id },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, remove, enable, disable.",
        },
      });
    } catch (err) {
      throw toolError(err, context, "manage_log_rule");
    }
  },
};

const listLogActionsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    type: logActionTypeEnum
      .optional()
      .describe("Filter by action type (exact match): memory, disk, remote, echo, email"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of actions to return (1-500, default 100)"),
  })
  .strict();

const listLogActionsTool: ToolDefinition = {
  name: "list_log_actions",
  title: "List Log Actions",
  description:
    "List RouterOS logging action targets (system/logging/action) with optional type filter.",
  inputSchema: listLogActionsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listLogActionsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing log actions");

    try {
      const all = await context.routerClient.get<RouterOSRecord>(LOG_ACTIONS_PATH, {
        limit: undefined,
        offset: undefined,
      });

      let actions = all as Record<string, string>[];

      if (parsed.type !== undefined) {
        actions = actions.filter((a) => a.type === parsed.type);
      }

      const returned = actions.slice(0, parsed.limit);

      return {
        content: `Log actions on ${context.routerId}: ${returned.length} action(s) (${all.length} total).`,
        structuredContent: {
          routerId: context.routerId,
          actions: returned,
          total: all.length,
          returned: returned.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_log_actions");
    }
  },
};

const manageLogActionInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Log action name — idempotency key"),
    type: logActionTypeEnum
      .optional()
      .describe("Action type: memory, disk, remote, echo, email (required on add)"),
    remote: z.string().optional().describe("Remote syslog server address (for type=remote)"),
    remotePort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("Remote syslog server port (for type=remote)"),
    diskFileName: z
      .string()
      .optional()
      .describe("Disk log file name without extension (for type=disk)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageLogActionTool: ToolDefinition = {
  name: "manage_log_action",
  title: "Manage Log Action",
  description:
    "Add or remove a RouterOS logging action target. Idempotent by name. " +
    "add throws VALIDATION if type is missing; returns already_exists if name found. " +
    "remove returns not_found gracefully. Supports dry-run.",
  inputSchema: manageLogActionInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["system/logging/action"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageLogActionInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing log action",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(LOG_ACTIONS_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find((a) => a.name === parsed.name);

      if (parsed.action === "add") {
        if (parsed.type === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "LOG_ACTION_TYPE_REQUIRED",
            message: "type is required when action is add",
            recoverability: {
              retryable: false,
              suggestedAction:
                "Provide the type field: memory, disk, remote, echo, or email.",
            },
          });
        }

        if (existing) {
          return {
            content: `Log action "${parsed.name}" already exists.`,
            structuredContent: {
              action: "already_exists",
              routerId: context.routerId,
              name: parsed.name,
              id: existing[".id"],
            },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          type: parsed.type,
        };
        if (parsed.remote !== undefined) body.remote = parsed.remote;
        if (parsed.remotePort !== undefined) body["remote-port"] = String(parsed.remotePort);
        if (parsed.diskFileName !== undefined) body["disk-file-name"] = parsed.diskFileName;

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add log action "${parsed.name}" (type=${parsed.type}).`,
            structuredContent: {
              action: "dry_run",
              diff: Object.entries(body).map(([property, after]) => ({
                property,
                before: null,
                after,
              })),
            },
          };
        }

        const created = await context.routerClient.create(LOG_ACTIONS_PATH, body);
        log.info({ name: parsed.name, type: parsed.type, id: created[".id"] }, "Log action added");
        return {
          content: `Added log action "${parsed.name}" (type=${parsed.type}).`,
          structuredContent: {
            action: "created",
            routerId: context.routerId,
            name: parsed.name,
            id: created[".id"],
          },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Log action "${parsed.name}" not found. No changes made.`,
            structuredContent: {
              action: "not_found",
              routerId: context.routerId,
              name: parsed.name,
            },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove log action "${parsed.name}".`,
            structuredContent: { action: "dry_run", name: parsed.name, id },
          };
        }

        await context.routerClient.remove(LOG_ACTIONS_PATH, id);
        log.info({ name: parsed.name, id }, "Log action removed");
        return {
          content: `Removed log action "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, remove.",
        },
      });
    } catch (err) {
      throw toolError(err, context, "manage_log_action");
    }
  },
};

export const logTools: ToolDefinition[] = [
  listLogRulesTool,
  manageLogRuleTool,
  listLogActionsTool,
  manageLogActionTool,
];

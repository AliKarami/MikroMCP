import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("policy-routing-tools");

const ROUTING_RULE_PATH = "routing/rule";
const ROUTING_TABLE_PATH = "routing/table";

const listRoutingRulesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    table: z.string().optional().describe("Filter by routing table name"),
    disabled: z.boolean().optional().describe("Filter by disabled state"),
  })
  .strict();

const listRoutingRulesTool: ToolDefinition = {
  name: "list_routing_rules",
  title: "List Routing Rules",
  description:
    "List policy routing rules on a MikroTik router in evaluation order. Supports filtering by table and disabled state.",
  inputSchema: listRoutingRulesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listRoutingRulesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing routing rules");

    try {
      let rules = await context.routerClient.get<RouterOSRecord>(ROUTING_RULE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.table !== undefined) {
        rules = rules.filter((r) => (r as Record<string, string>).table === parsed.table);
      }
      if (parsed.disabled !== undefined) {
        rules = rules.filter((r) => {
          const rec = r as Record<string, unknown>;
          const isDisabled = rec.disabled === true || rec.disabled === "true";
          return isDisabled === parsed.disabled;
        });
      }

      return {
        content: `Routing rules on ${context.routerId}: ${rules.length} rule(s).`,
        structuredContent: { routerId: context.routerId, rules, total: rules.length },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_routing_rules" });
    }
  },
};

const manageRoutingRuleInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    table: z
      .string()
      .describe(
        "Routing table name — part of the composite idempotency key; required for all actions",
      ),
    srcAddress: z.string().optional().describe("Source CIDR to match"),
    dstAddress: z.string().optional().describe("Destination CIDR to match"),
    interface: z.string().optional().describe("Incoming interface to match"),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4294967295)
      .optional()
      .describe("Rule priority (0–4294967295)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

function findRoutingRule(
  rules: RouterOSRecord[],
  srcAddress: string | undefined,
  dstAddress: string | undefined,
  iface: string | undefined,
  table: string,
): Record<string, string> | undefined {
  return rules.find((r) => {
    const rec = r as Record<string, string>;
    return (
      (rec["src-address"] ?? "") === (srcAddress ?? "") &&
      (rec["dst-address"] ?? "") === (dstAddress ?? "") &&
      (rec["interface"] ?? "") === (iface ?? "") &&
      rec.table === table
    );
  }) as Record<string, string> | undefined;
}

const manageRoutingRuleTool: ToolDefinition = {
  name: "manage_routing_rule",
  title: "Manage Routing Rule",
  description:
    "Add, remove, enable, or disable a policy routing rule. Idempotent by srcAddress+dstAddress+interface+table composite key. Supports dry-run mode.",
  inputSchema: manageRoutingRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageRoutingRuleInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, table: parsed.table },
      "Managing routing rule",
    );

    try {
      const allRules = await context.routerClient.get<RouterOSRecord>(ROUTING_RULE_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = findRoutingRule(
        allRules,
        parsed.srcAddress,
        parsed.dstAddress,
        parsed.interface,
        parsed.table,
      );

      if (parsed.action === "add") {
        if (
          parsed.srcAddress === undefined &&
          parsed.dstAddress === undefined &&
          parsed.interface === undefined
        ) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "MATCH_REQUIRED",
            message:
              "At least one of srcAddress, dstAddress, or interface must be provided when action is add",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide at least one of srcAddress, dstAddress, or interface.",
            },
          });
        }

        if (existing) {
          return {
            content: `Routing rule for table "${parsed.table}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", rule: existing },
          };
        }

        const body: Record<string, string> = { table: parsed.table };
        if (parsed.srcAddress !== undefined) body["src-address"] = parsed.srcAddress;
        if (parsed.dstAddress !== undefined) body["dst-address"] = parsed.dstAddress;
        if (parsed.interface !== undefined) body["interface"] = parsed.interface;
        if (parsed.priority !== undefined) body.priority = String(parsed.priority);

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add routing rule for table "${parsed.table}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(ROUTING_RULE_PATH, body);
        log.info({ table: parsed.table, id: created[".id"] }, "Routing rule added");

        return {
          content: `Added routing rule for table "${parsed.table}".`,
          structuredContent: { action: "created", rule: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Routing rule for table "${parsed.table}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", table: parsed.table },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove routing rule for table "${parsed.table}".`,
            structuredContent: { action: "dry_run", id, table: parsed.table },
          };
        }

        await context.routerClient.remove(ROUTING_RULE_PATH, id);
        log.info({ id, table: parsed.table }, "Routing rule removed");

        return {
          content: `Removed routing rule for table "${parsed.table}".`,
          structuredContent: { action: "removed", id, table: parsed.table },
        };
      }

      if (parsed.action === "enable" || parsed.action === "disable") {
        const wantDisabled = parsed.action === "disable";

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "ROUTING_RULE_NOT_FOUND",
            message: `No routing rule found matching table="${parsed.table}".`,
            details: {
              table: parsed.table,
              srcAddress: parsed.srcAddress,
              dstAddress: parsed.dstAddress,
              interface: parsed.interface,
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the rule using list_routing_rules.",
              alternativeTools: ["list_routing_rules"],
            },
          });
        }

        const id = existing[".id"];
        const isDisabled = existing.disabled === "true";

        if (isDisabled === wantDisabled) {
          return {
            content: `Routing rule is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, table: parsed.table },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
          ];
          return {
            content: `Dry run: Would ${parsed.action} routing rule for table "${parsed.table}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(ROUTING_RULE_PATH, id, {
          disabled: wantDisabled ? "true" : "false",
        });
        log.info({ id, table: parsed.table, action: parsed.action }, "Routing rule toggled");

        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} routing rule for table "${parsed.table}".`,
          structuredContent: { action: "updated", id, table: parsed.table },
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
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_routing_rule" });
    }
  },
};

const listRoutingTablesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
  })
  .strict();

const listRoutingTablesTool: ToolDefinition = {
  name: "list_routing_tables",
  title: "List Routing Tables",
  description: "List custom routing tables on a MikroTik router.",
  inputSchema: listRoutingTablesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    listRoutingTablesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing routing tables");

    try {
      const tables = await context.routerClient.get<RouterOSRecord>(ROUTING_TABLE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      return {
        content: `Routing tables on ${context.routerId}: ${tables.length} table(s).`,
        structuredContent: { routerId: context.routerId, tables, total: tables.length },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_routing_tables" });
    }
  },
};

const manageRoutingTableInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Routing table name (idempotency key)"),
    fib: z.boolean().default(false).describe("Whether to sync this table with the FIB"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageRoutingTableTool: ToolDefinition = {
  name: "manage_routing_table",
  title: "Manage Routing Table",
  description:
    "Create or remove a custom routing table. Idempotent by table name. Supports dry-run mode.",
  inputSchema: manageRoutingTableInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageRoutingTableInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing routing table",
    );

    try {
      const existing = await context.routerClient.get<RouterOSRecord>(ROUTING_TABLE_PATH, {
        filter: { name: parsed.name },
      });
      const found = existing.length > 0 ? (existing[0] as Record<string, string>) : undefined;

      if (parsed.action === "add") {
        if (found) {
          return {
            content: `Routing table "${parsed.name}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", table: found },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          fib: parsed.fib ? "true" : "false",
        };

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would create routing table "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(ROUTING_TABLE_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "Routing table created");

        return {
          content: `Created routing table "${parsed.name}".`,
          structuredContent: { action: "created", table: created },
        };
      }

      if (parsed.action === "remove") {
        if (!found) {
          return {
            content: `Routing table "${parsed.name}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", name: parsed.name },
          };
        }

        const id = found[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove routing table "${parsed.name}".`,
            structuredContent: { action: "dry_run", id, name: parsed.name },
          };
        }

        await context.routerClient.remove(ROUTING_TABLE_PATH, id);
        log.info({ id, name: parsed.name }, "Routing table removed");

        return {
          content: `Removed routing table "${parsed.name}".`,
          structuredContent: { action: "removed", id, name: parsed.name },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: { retryable: false, suggestedAction: "Use one of: add, remove." },
      });
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_routing_table" });
    }
  },
};

export const policyRoutingTools: ToolDefinition[] = [
  listRoutingRulesTool,
  manageRoutingRuleTool,
  listRoutingTablesTool,
  manageRoutingTableTool,
];

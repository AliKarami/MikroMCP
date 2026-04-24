// ---------------------------------------------------------------------------
// MikroMCP - Firewall rule management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("firewall-tools");

function tableToPath(table: "filter" | "nat"): string {
  return table === "filter" ? "ip/firewall/filter" : "ip/firewall/nat";
}

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

async function findRuleByComment(
  context: ToolContext,
  path: string,
  comment: string,
): Promise<Record<string, string> | undefined> {
  const results = await context.routerClient.get<RouterOSRecord>(path, {
    filter: { comment },
  });
  return results.length > 0 ? (results[0] as Record<string, string>) : undefined;
}

// ---------------------------------------------------------------------------
// list_firewall_rules
// ---------------------------------------------------------------------------

const listFirewallRulesInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  table: z.enum(["filter", "nat"]).default("filter")
    .describe("Firewall table to query: filter or nat"),
  chain: z.string().optional()
    .describe("Filter rules by chain name (e.g. forward, input, srcnat)"),
  disabled: z.enum(["true", "false", "all"]).default("all")
    .describe("Filter by disabled state: true, false, or all"),
  limit: z.number().int().min(1).max(500).default(100)
    .describe("Maximum number of rules to return"),
  offset: z.number().int().min(0).default(0)
    .describe("Offset for pagination"),
}).strict();

const listFirewallRulesTool: ToolDefinition = {
  name: "list_firewall_rules",
  title: "List Firewall Rules",
  description:
    "List firewall rules from the filter or nat table on a MikroTik router. Supports filtering by chain and disabled state, with pagination.",
  inputSchema: listFirewallRulesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listFirewallRulesInputSchema.parse(params);

    log.info(
      { routerId: context.routerId, table: parsed.table, chain: parsed.chain, disabled: parsed.disabled },
      "Listing firewall rules",
    );

    try {
      const path = tableToPath(parsed.table);
      let rules = await context.routerClient.get<RouterOSRecord>(path, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.chain !== undefined) {
        rules = rules.filter((r) => {
          const rec = r as Record<string, string>;
          return rec.chain === parsed.chain;
        });
      }

      if (parsed.disabled !== "all") {
        rules = rules.filter((r) => {
          const rec = r as Record<string, unknown>;
          const isDisabled = rec.disabled === true || rec.disabled === "true";
          return isDisabled === (parsed.disabled === "true");
        });
      }

      const total = rules.length;
      const paginated = rules.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      const lines: string[] = [
        `Firewall ${parsed.table} rules on ${context.routerId}: ${total} total, showing ${paginated.length} (offset ${parsed.offset})`,
      ];

      for (const rule of paginated) {
        const rec = rule as Record<string, unknown>;

        const chain = rec.chain ?? "?";
        const action = rec.action ?? "?";
        const isDisabled = rec.disabled === true || rec.disabled === "true";

        let line = `  [${chain}]`;

        if (rec.protocol !== undefined) {
          line += ` ${rec.protocol}`;
        }

        if (rec["src-address"] !== undefined) {
          line += ` src:${rec["src-address"]}`;
        }

        if (rec["dst-address"] !== undefined) {
          line += ` dst:${rec["dst-address"]}`;
        }

        line += ` => ${action}`;

        if (isDisabled) {
          line += " [disabled]";
        }

        if (rec.comment !== undefined) {
          line += ` // ${rec.comment}`;
        }

        lines.push(line);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          table: parsed.table,
          rules: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_firewall_rules" });
    }
  },
};

// ---------------------------------------------------------------------------
// manage_firewall_rule
// ---------------------------------------------------------------------------

const manageFirewallRuleInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  table: z.enum(["filter", "nat"]).default("filter")
    .describe("Firewall table to manage: filter or nat"),
  action: z.enum(["add", "remove", "disable", "enable"])
    .describe("Action to perform: add, remove, disable, or enable a firewall rule"),
  chain: z.string().describe("Firewall chain (e.g. forward, input, output, srcnat, dstnat)"),
  ruleAction: z.string().describe("RouterOS rule action (e.g. accept, drop, reject, masquerade)"),
  srcAddress: z.string().optional().describe("Source address or network"),
  dstAddress: z.string().optional().describe("Destination address or network"),
  protocol: z.enum(["tcp", "udp", "icmp", "gre", "ospf", "all"]).optional()
    .describe("Protocol to match"),
  srcPort: z.string().optional().describe("Source port or range"),
  dstPort: z.string().optional().describe("Destination port or range"),
  inInterface: z.string().optional().describe("Incoming interface"),
  outInterface: z.string().optional().describe("Outgoing interface"),
  comment: z.string().max(255).optional()
    .describe("Comment to identify the rule (used as idempotency key)"),
  disabled: z.boolean().default(false)
    .describe("Whether the rule should be disabled"),
  placeBefore: z.string().optional()
    .describe("Place the new rule before this rule ID"),
  dryRun: z.boolean().default(false)
    .describe("If true, validate and return planned changes without applying"),
}).strict();

const manageFirewallRuleTool: ToolDefinition = {
  name: "manage_firewall_rule",
  title: "Manage Firewall Rule",
  description:
    "Add, remove, disable, or enable a firewall rule on a MikroTik router. Uses comment as idempotency key for deduplication and identification. Supports dry-run mode.",
  inputSchema: manageFirewallRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageFirewallRuleInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info(
      { routerId: context.routerId, action: parsed.action, table: parsed.table, chain: parsed.chain },
      "Managing firewall rule",
    );

    const path = tableToPath(parsed.table);

    try {
      // -----------------------------------------------------------------------
      // ADD
      // -----------------------------------------------------------------------
      if (parsed.action === "add") {
        if (comment !== undefined) {
          const existing = await findRuleByComment(context, path, comment);
          if (existing) {
            return {
              content: `Firewall ${parsed.table} rule with comment "${comment}" already exists. No changes made.`,
              structuredContent: { action: "already_exists", rule: existing },
            };
          }
        }

        const body: Record<string, string> = {
          chain: parsed.chain,
          action: parsed.ruleAction,
          disabled: parsed.disabled ? "true" : "false",
        };

        if (comment !== undefined) body.comment = comment;
        if (parsed.srcAddress !== undefined) body["src-address"] = parsed.srcAddress;
        if (parsed.dstAddress !== undefined) body["dst-address"] = parsed.dstAddress;
        if (parsed.protocol !== undefined && parsed.protocol !== "all") body.protocol = parsed.protocol;
        if (parsed.srcPort !== undefined) body["src-port"] = parsed.srcPort;
        if (parsed.dstPort !== undefined) body["dst-port"] = parsed.dstPort;
        if (parsed.inInterface !== undefined) body["in-interface"] = parsed.inInterface;
        if (parsed.outInterface !== undefined) body["out-interface"] = parsed.outInterface;
        if (parsed.placeBefore !== undefined) body["place-before"] = parsed.placeBefore;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({ property, before: null, after }));
          return {
            content: `Dry run: Would add firewall ${parsed.table} rule in chain "${parsed.chain}" with action "${parsed.ruleAction}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(path, body);

        log.info({ chain: parsed.chain, ruleAction: parsed.ruleAction, id: created[".id"] }, "Firewall rule added");

        return {
          content: `Added firewall ${parsed.table} rule in chain "${parsed.chain}" with action "${parsed.ruleAction}".`,
          structuredContent: { action: "created", rule: created },
        };
      }

      // -----------------------------------------------------------------------
      // REMOVE
      // -----------------------------------------------------------------------
      if (parsed.action === "remove") {
        if (comment === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "REMOVE_REQUIRES_COMMENT",
            message: "Removing a firewall rule requires a comment to identify it unambiguously.",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a comment field that uniquely identifies the rule to remove.",
            },
          });
        }

        const existing = await findRuleByComment(context, path, comment);
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "FIREWALL_RULE_NOT_FOUND",
            message: `No ${parsed.table} rule found with comment "${comment}".`,
            details: { table: parsed.table, comment },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the comment using list_firewall_rules.",
              alternativeTools: ["list_firewall_rules"],
            },
          });
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove firewall ${parsed.table} rule with comment "${comment}".`,
            structuredContent: { action: "dry_run", id, comment },
          };
        }

        await context.routerClient.remove(path, id);

        log.info({ id, comment }, "Firewall rule removed");

        return {
          content: `Removed firewall ${parsed.table} rule with comment "${comment}".`,
          structuredContent: { action: "removed", id, comment },
        };
      }

      // -----------------------------------------------------------------------
      // DISABLE / ENABLE
      // -----------------------------------------------------------------------
      if (parsed.action === "disable" || parsed.action === "enable") {
        const wantDisabled = parsed.action === "disable";

        if (comment === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "TOGGLE_REQUIRES_COMMENT",
            message: `${parsed.action === "disable" ? "Disabling" : "Enabling"} a firewall rule requires a comment to identify it.`,
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a comment field that uniquely identifies the rule.",
            },
          });
        }

        const existing = await findRuleByComment(context, path, comment);
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "FIREWALL_RULE_NOT_FOUND",
            message: `No ${parsed.table} rule found with comment "${comment}".`,
            details: { table: parsed.table, comment },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the comment using list_firewall_rules.",
              alternativeTools: ["list_firewall_rules"],
            },
          });
        }

        const id = existing[".id"];
        const isDisabled = existing.disabled === "true";

        if (isDisabled === wantDisabled) {
          return {
            content: `Firewall ${parsed.table} rule with comment "${comment}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, comment },
          };
        }

        if (parsed.dryRun) {
          const diff = [{ property: "disabled", before: String(isDisabled), after: String(wantDisabled) }];
          return {
            content: `Dry run: Would ${parsed.action} firewall ${parsed.table} rule with comment "${comment}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(path, id, { disabled: wantDisabled ? "true" : "false" });

        log.info({ id, comment, action: parsed.action }, "Firewall rule toggled");

        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} firewall ${parsed.table} rule with comment "${comment}".`,
          structuredContent: { action: parsed.action, id, comment },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, remove, disable, enable.",
        },
      });
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_firewall_rule" });
    }
  },
};

export const firewallTools: ToolDefinition[] = [listFirewallRulesTool, manageFirewallRuleTool];

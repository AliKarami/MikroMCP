// ---------------------------------------------------------------------------
// MikroMCP - Firewall rule management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { sameRuleValue } from "./rule-match.js";
import { limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { paginate, listContent, compactFields } from "./pagination.js";
import type { RouterOSRecord } from "../../types.js";
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

/** Optional match and NAT-target parameters, mapped to their RouterOS property names. */
const RULE_FIELDS = [
  ["srcAddress", "src-address"],
  ["dstAddress", "dst-address"],
  ["srcPort", "src-port"],
  ["dstPort", "dst-port"],
  ["inInterface", "in-interface"],
  ["outInterface", "out-interface"],
  ["inInterfaceList", "in-interface-list"],
  ["outInterfaceList", "out-interface-list"],
  ["connectionState", "connection-state"],
  ["connectionNatState", "connection-nat-state"],
  ["toAddresses", "to-addresses"],
  ["toPorts", "to-ports"],
] as const;

/** NAT actions that accept `to-addresses` (help.mikrotik.com, NAT page). */
const TO_ADDRESSES_ACTIONS: ReadonlySet<string> = new Set(["dst-nat", "src-nat", "netmap", "same"]);

/** NAT actions that accept `to-ports`. */
const TO_PORTS_ACTIONS: ReadonlySet<string> = new Set([
  ...TO_ADDRESSES_ACTIONS,
  "redirect",
  "masquerade",
]);

const CONNECTION_STATE = "(established|related|new|invalid|untracked)";

/** A port 1–65535, or a range `start-end` with start <= end. */
function isPortOrRange(value: string): boolean {
  const [start, end = start] = value.split("-").map(Number);
  return start >= 1 && end <= 65535 && start <= end;
}

// ---------------------------------------------------------------------------
// list_firewall_rules
// ---------------------------------------------------------------------------

const listFirewallRulesInputSchema = z
  .object({
    routerId,
    table: z
      .enum(["filter", "nat"])
      .default("filter")
      .describe("Firewall table to query: filter or nat"),
    chain: z
      .string()
      .optional()
      .describe("Filter rules by chain name (e.g. forward, input, srcnat)"),
    disabled: z
      .enum(["true", "false", "all"])
      .default("all")
      .describe("Filter by disabled state: true, false, or all"),
    limit,
    offset,
  })
  .strict();

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
      {
        routerId: context.routerId,
        table: parsed.table,
        chain: parsed.chain,
        disabled: parsed.disabled,
      },
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
          const isDisabled = isTrue(rec.disabled);
          return isDisabled === (parsed.disabled === "true");
        });
      }

      const { items: paginated, total, hasMore } = paginate(rules, parsed.offset, parsed.limit);

      return {
        content: listContent(
          `Firewall ${parsed.table} rules`,
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (r) =>
            compactFields(r, [
              "chain",
              "action",
              "protocol",
              "src-address",
              "dst-address",
              "dst-port",
              "in-interface",
              "out-interface",
              "in-interface-list",
              "out-interface-list",
              "connection-state",
              "connection-nat-state",
              "to-addresses",
              "to-ports",
              "disabled",
              "comment",
            ]),
        ),
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
      throw toolError(err, context, "list_firewall_rules");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_firewall_rule
// ---------------------------------------------------------------------------

const manageFirewallRuleInputSchema = z
  .object({
    routerId,
    table: z
      .enum(["filter", "nat"])
      .default("filter")
      .describe("Firewall table to manage: filter or nat"),
    action: z
      .enum(["add", "remove", "disable", "enable"])
      .describe("Action to perform: add, remove, disable, or enable a firewall rule"),
    chain: z.string().describe("Firewall chain (e.g. forward, input, output, srcnat, dstnat)"),
    ruleAction: z.string().describe("RouterOS rule action (e.g. accept, drop, reject, masquerade)"),
    srcAddress: z.string().min(1).optional().describe("Source address or network"),
    dstAddress: z.string().min(1).optional().describe("Destination address or network"),
    protocol: z
      .enum(["tcp", "udp", "icmp", "gre", "ospf", "all"])
      .optional()
      .describe("Protocol to match"),
    srcPort: z.string().min(1).optional().describe("Source port or range"),
    dstPort: z.string().min(1).optional().describe("Destination port or range"),
    inInterface: z.string().min(1).optional().describe("Incoming interface"),
    outInterface: z.string().min(1).optional().describe("Outgoing interface"),
    inInterfaceList: z
      .string()
      .min(1)
      .optional()
      .describe("Incoming interface list, e.g. WAN or !LAN"),
    outInterfaceList: z
      .string()
      .min(1)
      .optional()
      .describe("Outgoing interface list, e.g. WAN or !LAN"),
    connectionState: z
      .string()
      .regex(new RegExp(`^!?${CONNECTION_STATE}(,${CONNECTION_STATE})*$`))
      .optional()
      .describe(
        "Connection-tracking states, comma-separated, optionally negated: established,related or !invalid",
      ),
    connectionNatState: z
      .string()
      .regex(/^!?(srcnat|dstnat|srcnat,dstnat|dstnat,srcnat)$/)
      .optional()
      .describe("Connection NAT state to match, e.g. dstnat or !dstnat"),
    toAddresses: z
      .string()
      .min(1)
      .optional()
      .describe("NAT target address or range (nat table only, e.g. dst-nat)"),
    toPorts: z
      .string()
      .regex(/^\d{1,5}(-\d{1,5})?$/)
      .refine(isPortOrRange, "Must be a port 1-65535 or an ascending range such as 8000-8100")
      .optional()
      .describe("NAT target port or range (nat table only)"),
    comment: z
      .string()
      .max(255)
      .optional()
      .describe("Comment to identify the rule (used as idempotency key)"),
    disabled: z.boolean().default(false).describe("Whether the rule should be disabled"),
    placeBefore: z.string().optional().describe("Place the new rule before this rule ID"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("If true, validate and return planned changes without applying"),
  })
  .strict();

const manageFirewallRuleTool: ToolDefinition = {
  name: "manage_firewall_rule",
  title: "Manage Firewall Rule",
  description:
    "Add, remove, disable, or enable a firewall rule on a MikroTik router. Matches addresses, ports, protocol, interfaces, interface lists, and connection/NAT state; nat rules take toAddresses/toPorts (e.g. a dst-nat port forward). Uses comment as idempotency key for deduplication and identification. Supports dry-run mode.",
  inputSchema: manageFirewallRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/firewall/filter", "ip/firewall/nat"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageFirewallRuleInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info(
      {
        routerId: context.routerId,
        action: parsed.action,
        table: parsed.table,
        chain: parsed.chain,
      },
      "Managing firewall rule",
    );

    const path = tableToPath(parsed.table);

    try {
      // -----------------------------------------------------------------------
      // ADD
      // -----------------------------------------------------------------------
      if (parsed.action === "add") {
        const natTargets = [
          ["toAddresses", parsed.toAddresses, TO_ADDRESSES_ACTIONS],
          ["toPorts", parsed.toPorts, TO_PORTS_ACTIONS],
        ] as const;
        for (const [param, value, actions] of natTargets) {
          if (value === undefined) continue;
          if (parsed.table !== "nat" || !actions.has(parsed.ruleAction)) {
            throw new MikroMCPError({
              category: ErrorCategory.VALIDATION,
              code: "NAT_TARGET_NOT_APPLICABLE",
              message: `${param} applies only to nat rules with ruleAction ${[...actions].join(", ")}.`,
              details: { param, table: parsed.table, ruleAction: parsed.ruleAction },
              recoverability: {
                retryable: false,
                suggestedAction: `Use table=nat with one of: ${[...actions].join(", ")}; or drop ${param}.`,
              },
            });
          }
        }

        const wantProtocol =
          parsed.protocol !== undefined && parsed.protocol !== "all" ? parsed.protocol : "";

        if (comment !== undefined) {
          const existing = await findRuleByComment(context, path, comment);
          if (existing) {
            const matches =
              existing.chain === parsed.chain &&
              existing.action === parsed.ruleAction &&
              sameRuleValue("protocol", existing.protocol, wantProtocol) &&
              RULE_FIELDS.every(([key, property]) =>
                sameRuleValue(property, existing[property], parsed[key]),
              );

            if (matches) {
              return {
                content: `Firewall ${parsed.table} rule with comment "${comment}" already exists. No changes made.`,
                structuredContent: { action: "already_exists", rule: existing },
              };
            }

            const existingDetails: Record<string, unknown> = {
              chain: existing.chain,
              action: existing.action,
              protocol: existing.protocol,
            };
            const requestedDetails: Record<string, unknown> = {
              chain: parsed.chain,
              action: parsed.ruleAction,
              protocol: wantProtocol || undefined,
            };
            for (const [key, property] of RULE_FIELDS) {
              existingDetails[property] = existing[property];
              requestedDetails[property] = parsed[key];
            }

            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "FIREWALL_RULE_CONFLICT",
              message: `Firewall ${parsed.table} rule with comment "${comment}" already exists but with different configuration.`,
              details: { existing: existingDetails, requested: requestedDetails },
              recoverability: {
                retryable: false,
                suggestedAction:
                  "Remove the existing rule first, then re-add with the desired configuration.",
                alternativeTools: ["manage_firewall_rule with action=remove"],
              },
            });
          }
        }

        const body: Record<string, string> = {
          chain: parsed.chain,
          action: parsed.ruleAction,
          disabled: parsed.disabled ? "true" : "false",
        };

        if (comment !== undefined) body.comment = comment;
        if (wantProtocol) body.protocol = wantProtocol;
        for (const [key, property] of RULE_FIELDS) {
          const value = parsed[key];
          if (value !== undefined) body[property] = value;
        }
        if (parsed.placeBefore !== undefined) body["place-before"] = parsed.placeBefore;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add firewall ${parsed.table} rule in chain "${parsed.chain}" with action "${parsed.ruleAction}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(path, body);

        log.info(
          { chain: parsed.chain, ruleAction: parsed.ruleAction, id: created[".id"] },
          "Firewall rule added",
        );

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
              suggestedAction:
                "Provide a comment field that uniquely identifies the rule to remove.",
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
        const isDisabled = isTrue(existing.disabled);

        if (isDisabled === wantDisabled) {
          return {
            content: `Firewall ${parsed.table} rule with comment "${comment}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, comment },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
          ];
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
      throw toolError(err, context, "manage_firewall_rule");
    }
  },
};

export const firewallTools: ToolDefinition[] = [listFirewallRulesTool, manageFirewallRuleTool];

import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { sameRuleValue } from "./rule-match.js";
import { dryRun, routerId, ruleComment } from "./schema-fields.js";
import { findRuleByComment, ruleCommentKey } from "./rule-comment.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("mangle-tools");

const MANGLE_PATH = "ip/firewall/mangle";

/** Match and mark parameters compared on a repeated add, mapped to their RouterOS property names. */
const MANGLE_RULE_FIELDS = [
  ["srcAddress", "src-address"],
  ["dstAddress", "dst-address"],
  ["srcAddressList", "src-address-list"],
  ["dstAddressList", "dst-address-list"],
  ["protocol", "protocol"],
  ["srcPort", "src-port"],
  ["dstPort", "dst-port"],
  ["inInterface", "in-interface"],
  ["outInterface", "out-interface"],
  ["newRoutingMark", "new-routing-mark"],
  ["newConnectionMark", "new-connection-mark"],
] as const;

/**
 * Compare a field RouterOS reports only for the actions that use it. `passthrough`
 * reads back as `true` on a rule added without it (the default is yes), but a rule
 * whose action ignores the field, such as the `accept` this tool creates when no
 * action applies, may not report it at all. A field the router does not report
 * cannot differ, so only a reported value is compared.
 */
function sameActionField(
  property: string,
  stored: unknown,
  requested: unknown,
  fallback?: unknown,
): boolean {
  if (stored === undefined) return true;
  return sameRuleValue(property, stored, requested ?? fallback);
}

const listMangleRulesInputSchema = z
  .object({
    routerId,
    chain: z
      .string()
      .optional()
      .describe("Filter by chain name (e.g. prerouting, forward, postrouting)"),
    action: z
      .string()
      .optional()
      .describe("Filter by mangle action (e.g. mark-routing, mark-connection)"),
    disabled: z.boolean().optional().describe("Filter by disabled state"),
  })
  .strict();

const listMangleRulesTool: ToolDefinition = {
  name: "list_mangle_rules",
  title: "List Mangle Rules",
  description:
    "List firewall mangle rules on a MikroTik router in evaluation order. Supports filtering by chain, action, and disabled state.",
  inputSchema: listMangleRulesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listMangleRulesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing mangle rules");

    try {
      let rules = await context.routerClient.get<RouterOSRecord>(MANGLE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.chain !== undefined) {
        rules = rules.filter((r) =>
          sameRuleValue("chain", (r as Record<string, unknown>).chain, parsed.chain),
        );
      }
      if (parsed.action !== undefined) {
        rules = rules.filter((r) => (r as Record<string, string>).action === parsed.action);
      }
      if (parsed.disabled !== undefined) {
        rules = rules.filter((r) => {
          const rec = r as Record<string, unknown>;
          const isDisabled = isTrue(rec.disabled);
          return isDisabled === parsed.disabled;
        });
      }

      return {
        content: listContent(
          "Mangle rules",
          context.routerId,
          rules as Record<string, string>[],
          rules.length,
          0,
          (r) =>
            compactFields(r, [
              "chain",
              "action",
              "new-packet-mark",
              "new-connection-mark",
              "new-routing-mark",
              "passthrough",
              "disabled",
              "comment",
            ]),
        ),
        structuredContent: { routerId: context.routerId, rules, total: rules.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_mangle_rules");
    }
  },
};

const manageMangleRuleInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    comment: ruleComment.describe("Idempotency key — uniquely identifies this mangle rule"),
    chain: z
      .string()
      .optional()
      .describe("Mangle chain (required on add): prerouting, input, forward, output, postrouting"),
    dryRun,
    srcAddress: z.string().optional().describe("Source IP/CIDR to match"),
    dstAddress: z.string().optional().describe("Destination IP/CIDR to match"),
    srcAddressList: z.string().optional().describe("Source address list name to match"),
    dstAddressList: z.string().optional().describe("Destination address list name to match"),
    protocol: z.string().optional().describe("Protocol to match (e.g. tcp, udp)"),
    srcPort: z.string().optional().describe("Source port or range"),
    dstPort: z.string().optional().describe("Destination port or range"),
    inInterface: z.string().optional().describe("Incoming interface to match"),
    outInterface: z.string().optional().describe("Outgoing interface to match"),
    newRoutingMark: z.string().optional().describe("Routing mark to set"),
    newConnectionMark: z.string().optional().describe("Connection mark to set"),
    newDscpValue: z.number().int().min(0).max(63).optional().describe("DSCP value to set (0–63)"),
    passthrough: z.boolean().optional().describe("Whether to continue matching subsequent rules"),
  })
  .strict();

const manageMangleRuleTool: ToolDefinition = {
  name: "manage_mangle_rule",
  title: "Manage Mangle Rule",
  description:
    "Add, remove, enable, or disable a firewall mangle rule. Uses comment as idempotency key: a repeated add returns already_exists only when the chain, match fields, marks, DSCP, and passthrough agree, otherwise CONFLICT. Supports dry-run mode.",
  inputSchema: manageMangleRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/firewall/mangle"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageMangleRuleInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, comment: parsed.comment },
      "Managing mangle rule",
    );

    try {
      const comment = ruleCommentKey(parsed.comment);

      if (parsed.action === "add") {
        if (parsed.chain === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "CHAIN_REQUIRED",
            message: "chain is required when action is add",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a chain value (e.g. prerouting, forward, postrouting).",
            },
          });
        }

        const existing = await findRuleByComment(context, MANGLE_PATH, comment);

        if (existing) {
          const matches =
            sameRuleValue("chain", existing.chain, parsed.chain) &&
            MANGLE_RULE_FIELDS.every(([key, property]) =>
              sameRuleValue(property, existing[property], parsed[key]),
            ) &&
            sameActionField("new-dscp", existing["new-dscp"], parsed.newDscpValue) &&
            sameActionField("passthrough", existing.passthrough, parsed.passthrough, true);

          if (matches) {
            return {
              content: `Mangle rule with comment "${comment}" already exists. No changes made.`,
              structuredContent: { action: "already_exists", rule: existing },
            };
          }

          const existingDetails: Record<string, unknown> = { chain: existing.chain };
          const requestedDetails: Record<string, unknown> = { chain: parsed.chain };
          for (const [key, property] of MANGLE_RULE_FIELDS) {
            existingDetails[property] = existing[property];
            requestedDetails[property] = parsed[key];
          }
          existingDetails["new-dscp"] = existing["new-dscp"];
          requestedDetails["new-dscp"] = parsed.newDscpValue;
          existingDetails.passthrough = existing.passthrough;
          // The effective value: an omitted passthrough means the RouterOS default yes.
          requestedDetails.passthrough = parsed.passthrough ?? true;

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "MANGLE_RULE_CONFLICT",
            message: `Mangle rule with comment "${comment}" already exists but with different configuration.`,
            details: { existing: existingDetails, requested: requestedDetails },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Remove the existing mangle rule first, then re-add with the desired configuration.",
              alternativeTools: ["manage_mangle_rule with action=remove"],
            },
          });
        }

        const body: Record<string, string> = {
          chain: parsed.chain!,
          comment,
        };

        if (parsed.srcAddress !== undefined) body["src-address"] = parsed.srcAddress;
        if (parsed.dstAddress !== undefined) body["dst-address"] = parsed.dstAddress;
        if (parsed.srcAddressList !== undefined) body["src-address-list"] = parsed.srcAddressList;
        if (parsed.dstAddressList !== undefined) body["dst-address-list"] = parsed.dstAddressList;
        if (parsed.protocol !== undefined) body.protocol = parsed.protocol;
        if (parsed.srcPort !== undefined) body["src-port"] = parsed.srcPort;
        if (parsed.dstPort !== undefined) body["dst-port"] = parsed.dstPort;
        if (parsed.inInterface !== undefined) body["in-interface"] = parsed.inInterface;
        if (parsed.outInterface !== undefined) body["out-interface"] = parsed.outInterface;
        if (parsed.newRoutingMark !== undefined) body["new-routing-mark"] = parsed.newRoutingMark;
        if (parsed.newConnectionMark !== undefined)
          body["new-connection-mark"] = parsed.newConnectionMark;
        if (parsed.newDscpValue !== undefined) body["new-dscp"] = String(parsed.newDscpValue);
        if (parsed.passthrough !== undefined) body.passthrough = parsed.passthrough ? "yes" : "no";

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add mangle rule in chain "${parsed.chain}" with comment "${comment}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(MANGLE_PATH, body);
        log.info({ comment, id: created[".id"] }, "Mangle rule added");

        return {
          content: `Added mangle rule in chain "${parsed.chain}" with comment "${comment}".`,
          structuredContent: { action: "created", rule: created },
        };
      }

      if (parsed.action === "remove") {
        const existing = await findRuleByComment(context, MANGLE_PATH, comment);
        if (!existing) {
          return {
            content: `Mangle rule with comment "${comment}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", comment },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove mangle rule with comment "${comment}".`,
            structuredContent: { action: "dry_run", id, comment },
          };
        }

        await context.routerClient.remove(MANGLE_PATH, id);
        log.info({ id, comment }, "Mangle rule removed");

        return {
          content: `Removed mangle rule with comment "${comment}".`,
          structuredContent: { action: "removed", id, comment },
        };
      }

      if (parsed.action === "enable" || parsed.action === "disable") {
        const wantDisabled = parsed.action === "disable";
        const existing = await findRuleByComment(context, MANGLE_PATH, comment);

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "MANGLE_RULE_NOT_FOUND",
            message: `No mangle rule found with comment "${comment}".`,
            details: { comment },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the comment using list_mangle_rules.",
              alternativeTools: ["list_mangle_rules"],
            },
          });
        }

        const id = existing[".id"];
        const isDisabled = isTrue(existing.disabled);

        if (isDisabled === wantDisabled) {
          return {
            content: `Mangle rule with comment "${comment}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, comment },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
          ];
          return {
            content: `Dry run: Would ${parsed.action} mangle rule with comment "${comment}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(MANGLE_PATH, id, {
          disabled: wantDisabled ? "true" : "false",
        });
        log.info({ id, comment, action: parsed.action }, "Mangle rule toggled");

        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} mangle rule with comment "${comment}".`,
          structuredContent: { action: "updated", id, comment },
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
      throw toolError(err, context, "manage_mangle_rule");
    }
  },
};

export const mangleTools: ToolDefinition[] = [listMangleRulesTool, manageMangleRuleTool];

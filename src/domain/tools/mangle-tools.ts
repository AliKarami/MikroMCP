import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { dryRun, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("mangle-tools");

const MANGLE_PATH = "ip/firewall/mangle";

async function findMangleRuleByComment(
  context: ToolContext,
  comment: string,
): Promise<Record<string, string> | undefined> {
  const results = await context.routerClient.get<RouterOSRecord>(MANGLE_PATH, {
    filter: { comment },
  });
  return results.length > 0 ? (results[0] as Record<string, string>) : undefined;
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
        rules = rules.filter((r) => (r as Record<string, string>).chain === parsed.chain);
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
    comment: z.string().describe("Idempotency key — uniquely identifies this mangle rule"),
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
    "Add, remove, enable, or disable a firewall mangle rule. Uses comment as idempotency key. Supports dry-run mode.",
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

        const existing = await findMangleRuleByComment(context, parsed.comment);

        if (existing) {
          const sameChain = existing.chain === parsed.chain;
          const sameSrcAddress = (existing["src-address"] ?? "") === (parsed.srcAddress ?? "");
          const sameDstAddress = (existing["dst-address"] ?? "") === (parsed.dstAddress ?? "");
          const sameSrcAddressList =
            (existing["src-address-list"] ?? "") === (parsed.srcAddressList ?? "");
          const sameDstAddressList =
            (existing["dst-address-list"] ?? "") === (parsed.dstAddressList ?? "");
          const sameNewRoutingMark =
            (existing["new-routing-mark"] ?? "") === (parsed.newRoutingMark ?? "");
          const sameNewConnectionMark =
            (existing["new-connection-mark"] ?? "") === (parsed.newConnectionMark ?? "");

          if (
            sameChain &&
            sameSrcAddress &&
            sameDstAddress &&
            sameSrcAddressList &&
            sameDstAddressList &&
            sameNewRoutingMark &&
            sameNewConnectionMark
          ) {
            return {
              content: `Mangle rule with comment "${parsed.comment}" already exists. No changes made.`,
              structuredContent: { action: "already_exists", rule: existing },
            };
          }

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "MANGLE_RULE_CONFLICT",
            message: `Mangle rule with comment "${parsed.comment}" already exists but with different configuration.`,
            details: {
              existing: {
                chain: existing.chain,
                "src-address": existing["src-address"],
                "dst-address": existing["dst-address"],
                "new-routing-mark": existing["new-routing-mark"],
                "new-connection-mark": existing["new-connection-mark"],
              },
              requested: {
                chain: parsed.chain,
                "src-address": parsed.srcAddress,
                "dst-address": parsed.dstAddress,
                "new-routing-mark": parsed.newRoutingMark,
                "new-connection-mark": parsed.newConnectionMark,
              },
            },
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
          comment: parsed.comment,
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
            content: `Dry run: Would add mangle rule in chain "${parsed.chain}" with comment "${parsed.comment}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(MANGLE_PATH, body);
        log.info({ comment: parsed.comment, id: created[".id"] }, "Mangle rule added");

        return {
          content: `Added mangle rule in chain "${parsed.chain}" with comment "${parsed.comment}".`,
          structuredContent: { action: "created", rule: created },
        };
      }

      if (parsed.action === "remove") {
        const existing = await findMangleRuleByComment(context, parsed.comment);
        if (!existing) {
          return {
            content: `Mangle rule with comment "${parsed.comment}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", comment: parsed.comment },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove mangle rule with comment "${parsed.comment}".`,
            structuredContent: { action: "dry_run", id, comment: parsed.comment },
          };
        }

        await context.routerClient.remove(MANGLE_PATH, id);
        log.info({ id, comment: parsed.comment }, "Mangle rule removed");

        return {
          content: `Removed mangle rule with comment "${parsed.comment}".`,
          structuredContent: { action: "removed", id, comment: parsed.comment },
        };
      }

      if (parsed.action === "enable" || parsed.action === "disable") {
        const wantDisabled = parsed.action === "disable";
        const existing = await findMangleRuleByComment(context, parsed.comment);

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "MANGLE_RULE_NOT_FOUND",
            message: `No mangle rule found with comment "${parsed.comment}".`,
            details: { comment: parsed.comment },
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
            content: `Mangle rule with comment "${parsed.comment}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, comment: parsed.comment },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
          ];
          return {
            content: `Dry run: Would ${parsed.action} mangle rule with comment "${parsed.comment}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(MANGLE_PATH, id, {
          disabled: wantDisabled ? "true" : "false",
        });
        log.info({ id, comment: parsed.comment, action: parsed.action }, "Mangle rule toggled");

        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} mangle rule with comment "${parsed.comment}".`,
          structuredContent: { action: "updated", id, comment: parsed.comment },
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

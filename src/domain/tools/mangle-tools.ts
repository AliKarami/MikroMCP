import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { protocolName, ruleActionAddOnly, sameRuleValue } from "./rule-match.js";
import { dryRun, routerId, ruleComment } from "./schema-fields.js";
import { findRuleByComment, ruleCommentKey } from "./rule-comment.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("mangle-tools");

const MANGLE_PATH = "ip/firewall/mangle";

/** Match parameters compared on a repeated add, mapped to their RouterOS property names. */
const MANGLE_MATCH_FIELDS = [
  ["srcAddress", "src-address"],
  ["dstAddress", "dst-address"],
  ["srcAddressList", "src-address-list"],
  ["dstAddressList", "dst-address-list"],
  ["protocol", "protocol"],
  ["srcPort", "src-port"],
  ["dstPort", "dst-port"],
  ["inInterface", "in-interface"],
  ["outInterface", "out-interface"],
  ["tcpFlags", "tcp-flags"],
] as const;

/**
 * Actions `ruleAction` accepts: `accept` (the documented RouterOS default) and
 * `passthrough` from the common firewall actions, and the mangle actions whose value
 * this tool can set. A subset of what RouterOS offers; `jump`, `route`, `change-ttl`
 * and the rest need parameters this tool does not have.
 */
const MANGLE_ACTIONS = [
  "accept",
  "passthrough",
  "mark-routing",
  "mark-connection",
  "mark-packet",
  "change-dscp",
  "change-mss",
] as const;

type MangleAction = (typeof MANGLE_ACTIONS)[number];

/**
 * The value parameter each value-setting action takes, with its RouterOS property.
 * Documented (RouterOS Mangle): each `new-*` property belongs to exactly one action.
 * Checked on CHR 7.23.2 and 7.24.2: under another action, including the default
 * `accept`, RouterOS creates the rule without an error and silently drops the value,
 * and an `accept` rule with `new-connection-mark` left live ICMP traffic unmarked.
 */
const ACTION_VALUE_PARAMS = [
  ["mark-routing", "newRoutingMark", "new-routing-mark"],
  ["mark-connection", "newConnectionMark", "new-connection-mark"],
  ["mark-packet", "newPacketMark", "new-packet-mark"],
  ["change-dscp", "newDscpValue", "new-dscp"],
  ["change-mss", "newMss", "new-mss"],
] as const;

/**
 * Compare a field RouterOS reports only for the actions that use it. `passthrough`
 * reads back as `true` on a rule added without it (the documented default is yes),
 * but a rule whose action ignores the field, such as a dynamic `passthrough` rule,
 * does not report it at all (seen on RouterOS 7.24.2). A field the router does not
 * report cannot differ, so only a reported value is compared. This is a choice of the
 * tool's idempotency check, not RouterOS behaviour.
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

/**
 * Built-in chains a routing mark cannot take effect in. Documented: "Action
 * mark-routing can be used only in mangle chain output and prerouting" (RouterOS,
 * Per connection classifier). RouterOS rejects such a rule as well (HTTP 400
 * "routing-mark allowed only in output and prerouting chains", CHR 7.23.2 and
 * 7.24.2); checking here first lets a dry run report it. A custom chain is let
 * through, since the chain that jumps to it is unknown here.
 */
const NO_ROUTING_MARK_CHAINS: ReadonlySet<string> = new Set(["input", "forward", "postrouting"]);

function validationError(
  code: string,
  message: string,
  details: Record<string, unknown>,
  suggestedAction: string,
): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code,
    message,
    details,
    recoverability: { retryable: false, suggestedAction },
  });
}

/**
 * Check an add before any router call, so a dry run reports what the add would hit.
 * Some checks repeat a RouterOS rejection; the others are stricter than RouterOS and
 * turn a rule it would create and never apply into a VALIDATION error. Each check
 * says which it is (CHR 7.23.2 and 7.24.2).
 */
function checkAddParams(parsed: z.infer<typeof manageMangleRuleInputSchema>): MangleAction {
  const ruleAction = parsed.ruleAction ?? "accept";
  for (const [action, param, property] of ACTION_VALUE_PARAMS) {
    const given = parsed[param] !== undefined;
    // Stricter than RouterOS, which creates the rule and drops the value.
    if (given && action !== ruleAction) {
      throw validationError(
        "MANGLE_FIELD_NOT_APPLICABLE",
        `${param} (${property}) applies only to ruleAction ${action}, not to ${ruleAction}.`,
        { ruleAction, param, requiredRuleAction: action },
        parsed.ruleAction === undefined
          ? `Set ruleAction to ${action}; without it the rule is accept and RouterOS drops ${property}.`
          : `Drop ${param}, or set ruleAction to ${action}.`,
      );
    }
    // Stricter than RouterOS, which creates a mark or dscp action without its value
    // (change-mss it rejects anyway, below); such a rule has nothing to set.
    if (!given && action === ruleAction) {
      throw validationError(
        "MANGLE_ACTION_VALUE_REQUIRED",
        `ruleAction ${action} needs ${param} (${property}).`,
        { ruleAction, param },
        `Provide ${param}.`,
      );
    }
  }

  if (ruleAction === "mark-routing" && NO_ROUTING_MARK_CHAINS.has(parsed.chain!)) {
    throw validationError(
      "MANGLE_CHAIN_NOT_APPLICABLE",
      `A routing mark set in chain ${parsed.chain} takes no effect; mark-routing works only in prerouting and output.`,
      { ruleAction, chain: parsed.chain },
      "Use chain prerouting for forwarded traffic or output for the router's own traffic.",
    );
  }

  // Repeats RouterOS, which answers HTTP 400 "tcp-flags works only with tcp" and, for
  // change-mss without protocol=tcp and tcp-flags=syn, "tcp mss change works only on
  // tcp syn packets". RouterOS takes protocol 6 and stores it as tcp.
  const tcp = parsed.protocol !== undefined && protocolName(parsed.protocol) === "tcp";
  const syn = (parsed.tcpFlags ?? "").split(",").includes("syn");
  if (ruleAction === "change-mss" && !(tcp && syn)) {
    throw validationError(
      "MANGLE_TCP_REQUIRED",
      "change-mss works only on TCP SYN packets; RouterOS rejects it without protocol tcp and tcpFlags syn.",
      { protocol: parsed.protocol, tcpFlags: parsed.tcpFlags },
      'Set protocol to "tcp" and tcpFlags to "syn".',
    );
  }
  if (parsed.tcpFlags !== undefined && !tcp) {
    throw validationError(
      "MANGLE_TCP_REQUIRED",
      `tcpFlags works only with TCP, but protocol is ${parsed.protocol ?? "not set"}.`,
      { protocol: parsed.protocol, tcpFlags: parsed.tcpFlags },
      'Set protocol to "tcp".',
    );
  }
  return ruleAction;
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
    tcpFlags: z
      .string()
      .min(1)
      .optional()
      .describe(
        'TCP flags to match, comma-separated, ! negates one (e.g. "syn"); needs protocol tcp',
      ),
    ruleAction: z
      .enum(MANGLE_ACTIONS)
      .optional()
      .describe(
        "Mangle action, add only; default accept, as in RouterOS. Each new* value needs its action: newRoutingMark → mark-routing, newConnectionMark → mark-connection, newPacketMark → mark-packet, newDscpValue → change-dscp, newMss → change-mss",
      ),
    newRoutingMark: z
      .string()
      .min(1)
      .optional()
      .describe("Routing mark to set (ruleAction mark-routing, chain prerouting or output)"),
    newConnectionMark: z
      .string()
      .min(1)
      .optional()
      .describe("Connection mark to set (ruleAction mark-connection)"),
    newPacketMark: z
      .string()
      .min(1)
      .optional()
      .describe("Packet mark to set (ruleAction mark-packet)"),
    newDscpValue: z
      .number()
      .int()
      .min(0)
      .max(63)
      .optional()
      .describe("DSCP value to set, 0–63 (ruleAction change-dscp)"),
    // RouterOS documents new-mss as an integer with no range; 0–65535 is the size of
    // the TCP MSS option, and how RouterOS bounds it was not checked. clamp-to-pmtu is
    // named in the docs and stored as such (RB5009, RouterOS 7.24.2).
    newMss: z
      .union([z.number().int().min(0).max(65535), z.literal("clamp-to-pmtu")])
      .optional()
      .describe(
        "MSS to set: a number or clamp-to-pmtu (ruleAction change-mss, with protocol tcp and tcpFlags syn)",
      ),
    passthrough: z.boolean().optional().describe("Whether to continue matching subsequent rules"),
  })
  .strict();

const manageMangleRuleTool: ToolDefinition = {
  name: "manage_mangle_rule",
  title: "Manage Mangle Rule",
  description:
    "Add, remove, enable, or disable a firewall mangle rule. ruleAction sets the action (default accept); each new* value is accepted only with its action, e.g. newRoutingMark with mark-routing. Uses comment as idempotency key: a repeated add returns already_exists only when the chain, match fields, marks, DSCP, MSS, passthrough, and an explicit ruleAction agree, otherwise CONFLICT. Supports dry-run mode.",
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

      if (parsed.action !== "add" && parsed.ruleAction !== undefined) {
        // The rule is found by comment alone, so a ruleAction here would not narrow
        // which rule is removed or toggled.
        throw ruleActionAddOnly(
          parsed.action,
          parsed.ruleAction,
          "Drop ruleAction; the rule is identified by its comment.",
        );
      }

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

        const ruleAction = checkAddParams(parsed);
        const existing = await findRuleByComment(context, MANGLE_PATH, comment);

        if (existing) {
          // Only an explicit ruleAction is compared, so a repeated add without one still
          // finds a rule with any action, such as one added in WinBox. A value parameter
          // always comes with its explicit action, so comparing a value only when the
          // router reports it misses nothing: a rule of another action differs in action.
          const compareAction = parsed.ruleAction !== undefined;
          // A rule created without an action, as earlier versions of this tool did, has no
          // `action` field at all (CHR 7.23.2 and 7.24.2); it is the documented default
          // accept. Without this, such a rule would never differ in action.
          const existingAction = existing.action ?? "accept";
          const matches =
            (!compareAction || sameRuleValue("action", existingAction, parsed.ruleAction)) &&
            sameRuleValue("chain", existing.chain, parsed.chain) &&
            MANGLE_MATCH_FIELDS.every(([key, property]) =>
              sameRuleValue(property, existing[property], parsed[key]),
            ) &&
            ACTION_VALUE_PARAMS.every(([, param, property]) =>
              sameActionField(property, existing[property], parsed[param]),
            ) &&
            sameActionField("passthrough", existing.passthrough, parsed.passthrough, true);

          if (matches) {
            return {
              content: `Mangle rule with comment "${comment}" already exists. No changes made.`,
              structuredContent: { action: "already_exists", rule: existing },
            };
          }

          // The action is listed only when it was compared.
          const existingDetails: Record<string, unknown> = compareAction
            ? { action: existingAction, chain: existing.chain }
            : { chain: existing.chain };
          const requestedDetails: Record<string, unknown> = compareAction
            ? { action: parsed.ruleAction, chain: parsed.chain }
            : { chain: parsed.chain };
          for (const [key, property] of MANGLE_MATCH_FIELDS) {
            existingDetails[property] = existing[property];
            requestedDetails[property] = parsed[key];
          }
          for (const [, param, property] of ACTION_VALUE_PARAMS) {
            existingDetails[property] = existing[property];
            requestedDetails[property] = parsed[param];
          }
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
          action: ruleAction,
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
        if (parsed.tcpFlags !== undefined) body["tcp-flags"] = parsed.tcpFlags;
        for (const [, param, property] of ACTION_VALUE_PARAMS) {
          const value = parsed[param];
          if (value !== undefined) body[property] = String(value);
        }
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

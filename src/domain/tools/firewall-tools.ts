// ---------------------------------------------------------------------------
// MikroMCP - Firewall rule management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { sameRuleValue } from "./rule-match.js";
import {
  firewallFamily,
  firewallPath,
  limit,
  offset,
  rawFamily,
  routerId,
  ruleComment,
} from "./schema-fields.js";
import type { FirewallFamily } from "./schema-fields.js";
import { findRuleByComment, ruleCommentKey } from "./rule-comment.js";
import { toolError } from "./tool-definition.js";
import { paginate, listContent, compactFields } from "./pagination.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { autoRevertSeconds, autoRevertSummary, guardedWrite } from "./auto-revert.js";
import type { FirewallRevert } from "./auto-revert.js";
import {
  executeMove,
  moveDestination,
  moveDetails,
  moveRuleId,
  notForAction,
  planMove,
  requiredForAction,
} from "./rule-move.js";

const log = createLogger("firewall-tools");

const FIREWALL_TABLES = ["filter", "nat", "raw"] as const;

type FirewallTable = (typeof FIREWALL_TABLES)[number];

/** `filter` for IPv4, `ipv6 filter` for IPv6, as the tool's messages name a table. */
function tableLabel(family: FirewallFamily, table: FirewallTable): string {
  return family === "ipv6" ? `ipv6 ${table}` : table;
}

/** The table a raw (unparsed) call names. */
function rawTable(params: Record<string, unknown>): FirewallTable {
  const table = params.table;
  return FIREWALL_TABLES.find((t) => t === table) ?? "filter";
}

/**
 * `reject-with` values per family (RouterOS IPv4 and IPv6 filter pages). Each
 * family accepts only its own ICMP codes; `tcp-reset` and the admin-prohibited and
 * port-unreachable codes exist in both.
 */
const REJECT_WITH: Record<FirewallFamily, readonly string[]> = {
  ip: [
    "icmp-network-unreachable",
    "icmp-host-unreachable",
    "icmp-port-unreachable",
    "icmp-protocol-unreachable",
    "icmp-network-prohibited",
    "icmp-host-prohibited",
    "icmp-admin-prohibited",
    "tcp-reset",
  ],
  ipv6: [
    "icmp-no-route",
    "icmp-admin-prohibited",
    "icmp-not-neighbour",
    "icmp-address-unreachable",
    "icmp-port-unreachable",
    "tcp-reset",
  ],
};

const REJECT_WITH_VALUES = [...new Set([...REJECT_WITH.ip, ...REJECT_WITH.ipv6])] as [
  string,
  ...string[],
];

/** The documented `reject-with` default per family. */
const DEFAULT_REJECT_WITH: Record<FirewallFamily, string> = {
  ip: "icmp-network-unreachable",
  ipv6: "icmp-no-route",
};

/** Optional match, NAT-target, jump and reject parameters, mapped to their RouterOS property names. */
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
  ["jumpTarget", "jump-target"],
  ["rejectWith", "reject-with"],
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

/**
 * Compare one rule field on a repeated add. A reject rule added without
 * `reject-with` uses the family's default, and whether RouterOS then reports the
 * default or nothing was not checked, so for reject rules an absent value and the
 * default count as the same.
 */
function sameField(
  property: string,
  stored: unknown,
  requested: unknown,
  family: FirewallFamily,
  ruleAction: string,
): boolean {
  if (property === "reject-with" && ruleAction === "reject") {
    const fallback = DEFAULT_REJECT_WITH[family];
    const absent = (v: unknown) => v === undefined || v === "";
    return sameRuleValue(
      property,
      absent(stored) ? fallback : stored,
      absent(requested) ? fallback : requested,
    );
  }
  return sameRuleValue(property, stored, requested);
}

/** True when no state appears twice in a (possibly negated) state list. */
function hasNoRepeats(value: string): boolean {
  const items = value.replace(/^!/, "").split(",");
  return new Set(items).size === items.length;
}

// ---------------------------------------------------------------------------
// list_firewall_rules
// ---------------------------------------------------------------------------

const listFirewallRulesInputSchema = z
  .object({
    routerId,
    family: firewallFamily,
    table: z
      .enum(FIREWALL_TABLES)
      .default("filter")
      .describe("Firewall table to query: filter, nat or raw"),
    chain: z
      .string()
      .optional()
      .describe("Filter rules by chain name (e.g. forward, input, srcnat, prerouting)"),
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
    "List firewall rules from the filter, nat or raw table on a MikroTik router, IPv4 (family ip, the default) or IPv6 (family ipv6), in evaluation order. Supports filtering by chain and disabled state, with pagination.",
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
        family: parsed.family,
        table: parsed.table,
        chain: parsed.chain,
        disabled: parsed.disabled,
      },
      "Listing firewall rules",
    );

    try {
      const path = firewallPath(parsed.family, parsed.table);
      let rules = await context.routerClient.get<RouterOSRecord>(path, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.chain !== undefined) {
        rules = rules.filter((r) => {
          const rec = r as Record<string, unknown>;
          return sameRuleValue("chain", rec.chain, parsed.chain);
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
          `Firewall ${tableLabel(parsed.family, parsed.table)} rules`,
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
              "jump-target",
              "reject-with",
              "disabled",
              "comment",
            ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          family: parsed.family,
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
    family: firewallFamily,
    table: z
      .enum(FIREWALL_TABLES)
      .default("filter")
      .describe("Firewall table to manage: filter, nat or raw"),
    action: z
      .enum(["add", "remove", "disable", "enable", "move"])
      .describe(
        "Action to perform: add, remove, disable, or enable a rule (found by comment), or move a rule (by ruleId) before another",
      ),
    chain: z
      .string()
      .optional()
      .describe(
        "Firewall chain, required except for move (e.g. input, forward, output, srcnat, dstnat; raw: prerouting, output)",
      ),
    ruleAction: z
      .string()
      .optional()
      .describe(
        "RouterOS rule action, required except for move (e.g. accept, drop, reject, jump, masquerade; raw also notrack)",
      ),
    srcAddress: z.string().min(1).optional().describe("Source address or network"),
    dstAddress: z.string().min(1).optional().describe("Destination address or network"),
    protocol: z
      .enum(["tcp", "udp", "icmp", "icmpv6", "gre", "ospf", "all"])
      .optional()
      .describe("Protocol to match; ICMP is icmp for family ip and icmpv6 for family ipv6"),
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
      .refine(hasNoRepeats, "Each connection state may appear only once")
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
    jumpTarget: z
      .string()
      .min(1)
      .optional()
      .describe("Chain to jump to; required with ruleAction jump and rejected otherwise"),
    rejectWith: z
      .enum(REJECT_WITH_VALUES)
      .optional()
      .describe(
        "ICMP or TCP reply for ruleAction reject only. ip: icmp-network-unreachable (default), icmp-host-unreachable, icmp-port-unreachable, icmp-protocol-unreachable, icmp-network-prohibited, icmp-host-prohibited, icmp-admin-prohibited, tcp-reset. ipv6: icmp-no-route (default), icmp-admin-prohibited, icmp-not-neighbour, icmp-address-unreachable, icmp-port-unreachable, tcp-reset",
      ),
    comment: ruleComment
      .max(255)
      .optional()
      .describe("Comment to identify the rule (used as idempotency key); omit for none"),
    disabled: z.boolean().default(false).describe("Whether the rule should be disabled"),
    placeBefore: z.string().optional().describe("Place the new rule before this rule ID"),
    ruleId: moveRuleId,
    destination: moveDestination,
    dryRun: z
      .boolean()
      .default(false)
      .describe("If true, validate and return planned changes without applying"),
    autoRevertSeconds,
  })
  .strict();

/** What a dry run reports about the auto-revert job a real call would arm. */
function plannedAutoRevert(seconds: number): Record<string, unknown> {
  return { wouldArm: seconds > 0, seconds };
}

/**
 * What re-adding a removed rule needs: the first static rule after it, where it
 * must go back, and how many rules carry its comment, itself included.
 */
async function restoreTarget(
  context: ToolContext,
  path: string,
  rule: Record<string, unknown>,
): Promise<{ placeBefore?: string; sameComment: number }> {
  const rules = await context.routerClient.get<RouterOSRecord>(path, {});
  const at = rules.findIndex((r) => r[".id"] === rule[".id"]);
  // Dynamic rules cannot anchor place-before.
  const next = at < 0 ? undefined : rules.slice(at + 1).find((r) => !isTrue(r.dynamic));
  const sameComment = rules.filter((r) => r.comment === rule.comment).length;
  return {
    placeBefore: next === undefined ? undefined : String(next[".id"]),
    sameComment: Math.max(sameComment, 1),
  };
}

/** Run a write behind the auto-revert job unless it is turned off. */
async function applyWrite<T>(
  context: ToolContext,
  seconds: number,
  path: string,
  revert: FirewallRevert,
  description: string,
  write: (retarget: (revert: FirewallRevert) => Promise<void>) => Promise<T>,
): Promise<{ result: T; extra: Record<string, unknown>; note: string }> {
  if (seconds === 0) {
    return { result: await write(async () => {}), extra: {}, note: "" };
  }
  const { result, autoRevert } = await guardedWrite(
    context,
    { seconds, path, revert, description },
    write,
  );
  return { result, extra: { autoRevert }, note: `\n${autoRevertSummary(autoRevert)}` };
}

type ManageFirewallRuleParams = z.infer<typeof manageFirewallRuleInputSchema>;

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
 * Checks on an add that depend on the family and the rule action, run before any
 * router call so a dry run reports them. A jump without jump-target or a
 * reject-with on another action is what RouterOS rejects or ignores; the ICMP
 * protocol name and the reject-with codes differ between IPv4 and IPv6.
 */
function checkAddFields(parsed: ManageFirewallRuleParams, ruleAction: string): void {
  const { family } = parsed;
  if (parsed.protocol === "icmp" && family === "ipv6") {
    throw validationError(
      "PROTOCOL_FAMILY_MISMATCH",
      "IPv6 rules match ICMP as icmpv6; protocol icmp is the IPv4 protocol.",
      { family, protocol: parsed.protocol },
      'Use protocol "icmpv6" for family ipv6.',
    );
  }
  if (parsed.protocol === "icmpv6" && family === "ip") {
    throw validationError(
      "PROTOCOL_FAMILY_MISMATCH",
      "protocol icmpv6 applies to IPv6 rules; IPv4 ICMP is icmp.",
      { family, protocol: parsed.protocol },
      'Use protocol "icmp", or family ipv6.',
    );
  }
  if (ruleAction === "jump" && parsed.jumpTarget === undefined) {
    throw validationError(
      "JUMP_TARGET_REQUIRED",
      "ruleAction jump needs jumpTarget, the chain to jump to.",
      { ruleAction },
      "Provide jumpTarget.",
    );
  }
  if (parsed.jumpTarget !== undefined && ruleAction !== "jump") {
    throw validationError(
      "JUMP_TARGET_NOT_APPLICABLE",
      `jumpTarget applies only to ruleAction jump, not to ${ruleAction}.`,
      { ruleAction, jumpTarget: parsed.jumpTarget },
      "Drop jumpTarget, or set ruleAction to jump.",
    );
  }
  if (parsed.rejectWith !== undefined) {
    if (ruleAction !== "reject") {
      throw validationError(
        "REJECT_WITH_NOT_APPLICABLE",
        `rejectWith applies only to ruleAction reject, not to ${ruleAction}.`,
        { ruleAction, rejectWith: parsed.rejectWith },
        "Drop rejectWith, or set ruleAction to reject.",
      );
    }
    if (!REJECT_WITH[family].includes(parsed.rejectWith)) {
      throw validationError(
        "REJECT_WITH_FAMILY_MISMATCH",
        `rejectWith ${parsed.rejectWith} is not an ${family === "ipv6" ? "IPv6" : "IPv4"} reject reply.`,
        { family, rejectWith: parsed.rejectWith, allowed: REJECT_WITH[family] },
        `Use one of: ${REJECT_WITH[family].join(", ")}.`,
      );
    }
  }
}

/** Parameters that describe a rule, which a move (by ruleId) does not take. */
const NOT_FOR_MOVE = [
  "chain",
  "ruleAction",
  "comment",
  "protocol",
  "placeBefore",
  ...RULE_FIELDS.map(([key]) => key),
] as const;

async function moveRule(
  parsed: ManageFirewallRuleParams,
  context: ToolContext,
  path: string,
  label: string,
): Promise<ToolResult> {
  for (const param of NOT_FOR_MOVE) {
    if (parsed[param] !== undefined) {
      throw notForAction(
        param,
        "move",
        `Drop ${param}; a move takes the rule's ruleId and a destination.`,
      );
    }
  }
  if (parsed.ruleId === undefined) throw requiredForAction("ruleId", "move");
  if (parsed.destination === undefined) throw requiredForAction("destination", "move");

  const plan = await planMove(context, path, parsed.ruleId, parsed.destination, {
    rule: `${label} rule`,
    notFoundCode: "FIREWALL_RULE_NOT_FOUND",
    listTool: "list_firewall_rules",
  });
  const where = plan.destination === "end" ? "at the end" : `before ${plan.destination}`;

  if (plan.noChange) {
    return {
      content: `Firewall ${label} rule ${plan.id} is already ${where}. No changes made.`,
      structuredContent: { action: "no_change", ...moveDetails(plan) },
    };
  }

  if (parsed.dryRun) {
    return {
      content: `Dry run: Would move firewall ${label} rule ${plan.id} from position ${plan.from} to ${plan.to} (${where}).`,
      structuredContent: {
        action: "dry_run",
        ...moveDetails(plan),
        autoRevert: plannedAutoRevert(parsed.autoRevertSeconds),
      },
    };
  }

  const { extra, note } = await applyWrite(
    context,
    parsed.autoRevertSeconds,
    path,
    { kind: "move-back", id: plan.id, before: plan.previousNext },
    `move ${label} rule ${plan.id} ${where}`,
    () => executeMove(context, path, plan),
  );

  log.info({ id: plan.id, destination: plan.destination }, "Firewall rule moved");

  return {
    content: `Moved firewall ${label} rule ${plan.id} ${where} (position ${plan.from} to ${plan.to}).${note}`,
    structuredContent: { action: "moved", ...moveDetails(plan), ...extra },
  };
}

const manageFirewallRuleTool: ToolDefinition = {
  name: "manage_firewall_rule",
  title: "Manage Firewall Rule",
  description:
    "Add, remove, disable, enable, or move a firewall rule on a MikroTik router, in the filter, nat or raw table, IPv4 (family ip, the default) or IPv6 (family ipv6). Matches addresses, ports, protocol, interfaces, interface lists, and connection/NAT state; nat rules take toAddresses/toPorts (e.g. a dst-nat port forward), jump rules need jumpTarget, reject rules may set rejectWith. Uses comment as idempotency key for deduplication and identification: a repeated add returns already_exists only when the match, NAT targets, jump target, reject reply, and disabled state agree, otherwise CONFLICT (use enable/disable when only the disabled state differs). move takes ruleId and destination (a rule .id to place it before, or end) instead of chain/ruleAction/comment, and returns no_change when the rule is already there; dynamic rules cannot be moved. Supports dry-run mode. Every real write is guarded by a dead-man switch (autoRevertSeconds, default 60): a RouterOS scheduler job that undoes the change is armed first and removed only once the router answers a new REST connection afterwards, so a rule that locks out management reverts itself.",
  inputSchema: manageFirewallRuleInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: (params) => [firewallPath(rawFamily(params), rawTable(params))],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageFirewallRuleInputSchema.parse(params);
    log.info(
      {
        routerId: context.routerId,
        action: parsed.action,
        family: parsed.family,
        table: parsed.table,
        chain: parsed.chain,
      },
      "Managing firewall rule",
    );

    const path = firewallPath(parsed.family, parsed.table);
    const label = tableLabel(parsed.family, parsed.table);

    try {
      if (parsed.action === "move") return await moveRule(parsed, context, path, label);

      for (const param of ["ruleId", "destination"] as const) {
        if (parsed[param] !== undefined) {
          throw notForAction(
            param,
            parsed.action,
            `Drop ${param}; it is used only with action=move. add/remove/enable/disable find the rule by comment.`,
          );
        }
      }
      if (parsed.chain === undefined) throw requiredForAction("chain", parsed.action);
      if (parsed.ruleAction === undefined) throw requiredForAction("ruleAction", parsed.action);
      const chain = parsed.chain;
      const ruleAction = parsed.ruleAction;

      const comment = parsed.comment === undefined ? undefined : ruleCommentKey(parsed.comment);

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
          if (parsed.table !== "nat" || !actions.has(ruleAction)) {
            throw new MikroMCPError({
              category: ErrorCategory.VALIDATION,
              code: "NAT_TARGET_NOT_APPLICABLE",
              message: `${param} applies only to nat rules with ruleAction ${[...actions].join(", ")}.`,
              details: { param, family: parsed.family, table: parsed.table, ruleAction },
              recoverability: {
                retryable: false,
                suggestedAction: `Use table=nat with one of: ${[...actions].join(", ")}; or drop ${param}.`,
              },
            });
          }
        }

        checkAddFields(parsed, ruleAction);

        const wantProtocol =
          parsed.protocol !== undefined && parsed.protocol !== "all" ? parsed.protocol : "";

        if (comment !== undefined) {
          const existing = await findRuleByComment(context, path, comment);
          if (existing) {
            const sameMatch =
              sameRuleValue("chain", existing.chain, chain) &&
              existing.action === ruleAction &&
              sameRuleValue("protocol", existing.protocol, wantProtocol) &&
              RULE_FIELDS.every(([key, property]) =>
                sameField(property, existing[property], parsed[key], parsed.family, ruleAction),
              );
            const existingDisabled = isTrue(existing.disabled);

            if (sameMatch && existingDisabled === parsed.disabled) {
              return {
                content: `Firewall ${label} rule with comment "${comment}" already exists. No changes made.`,
                structuredContent: { action: "already_exists", rule: existing },
              };
            }

            const existingDetails: Record<string, unknown> = {
              chain: existing.chain,
              action: existing.action,
              protocol: existing.protocol,
            };
            const requestedDetails: Record<string, unknown> = {
              chain: chain,
              action: ruleAction,
              protocol: wantProtocol || undefined,
            };
            for (const [key, property] of RULE_FIELDS) {
              existingDetails[property] = existing[property];
              requestedDetails[property] = parsed[key];
            }
            existingDetails.disabled = existingDisabled;
            requestedDetails.disabled = parsed.disabled;

            // Only the disabled state differs: toggling the rule is enough.
            const toggle = parsed.disabled ? "disable" : "enable";
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "FIREWALL_RULE_CONFLICT",
              message: sameMatch
                ? `Firewall ${label} rule with comment "${comment}" already exists but is ${existingDisabled ? "disabled" : "enabled"}.`
                : `Firewall ${label} rule with comment "${comment}" already exists but with different configuration.`,
              details: { existing: existingDetails, requested: requestedDetails },
              recoverability: sameMatch
                ? {
                    retryable: false,
                    suggestedAction: `Use action=${toggle} with the same comment to ${toggle} the existing rule.`,
                    alternativeTools: [`manage_firewall_rule with action=${toggle}`],
                  }
                : {
                    retryable: false,
                    suggestedAction:
                      "Remove the existing rule first, then re-add with the desired configuration.",
                    alternativeTools: ["manage_firewall_rule with action=remove"],
                  },
            });
          }
        }

        const body: Record<string, string> = {
          chain: chain,
          action: ruleAction,
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
            content: `Dry run: Would add firewall ${label} rule in chain "${chain}" with action "${ruleAction}".`,
            structuredContent: {
              action: "dry_run",
              diff,
              autoRevert: plannedAutoRevert(parsed.autoRevertSeconds),
            },
          };
        }

        const knownIds =
          parsed.autoRevertSeconds === 0
            ? []
            : (await context.routerClient.get<RouterOSRecord>(path, {}))
                .filter((r) => sameRuleValue("chain", r.chain, chain))
                .map((r) => String(r[".id"]));

        const {
          result: created,
          extra,
          note,
        } = await applyWrite(
          context,
          parsed.autoRevertSeconds,
          path,
          { kind: "remove-new", chain: chain, knownIds },
          `add ${label} rule in chain ${chain}${comment === undefined ? "" : ` "${comment}"`}`,
          async (retarget) => {
            const rule = await context.routerClient.create(path, body);
            const id = rule[".id"];
            if (typeof id === "string") await retarget({ kind: "remove-id", id });
            return rule;
          },
        );

        log.info(
          { chain: chain, ruleAction: ruleAction, id: created[".id"] },
          "Firewall rule added",
        );

        return {
          content: `Added firewall ${label} rule in chain "${chain}" with action "${ruleAction}".${note}`,
          structuredContent: { action: "created", rule: created, ...extra },
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
            message: `No ${label} rule found with comment "${comment}".`,
            details: { family: parsed.family, table: parsed.table, comment },
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
            content: `Dry run: Would remove firewall ${label} rule with comment "${comment}".`,
            structuredContent: {
              action: "dry_run",
              id,
              comment,
              autoRevert: plannedAutoRevert(parsed.autoRevertSeconds),
            },
          };
        }

        const target =
          parsed.autoRevertSeconds > 0
            ? await restoreTarget(context, path, existing)
            : { sameComment: 1 };

        const { extra, note } = await applyWrite(
          context,
          parsed.autoRevertSeconds,
          path,
          { kind: "restore", record: existing, ...target },
          `remove ${label} rule "${comment}"`,
          () => context.routerClient.remove(path, id),
        );

        log.info({ id, comment }, "Firewall rule removed");

        return {
          content: `Removed firewall ${label} rule with comment "${comment}".${note}`,
          structuredContent: { action: "removed", id, comment, ...extra },
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
            message: `No ${label} rule found with comment "${comment}".`,
            details: { family: parsed.family, table: parsed.table, comment },
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
            content: `Firewall ${label} rule with comment "${comment}" is already ${wantDisabled ? "disabled" : "enabled"}. No changes made.`,
            structuredContent: { action: "no_change", id, comment },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "disabled", before: String(isDisabled), after: String(wantDisabled) },
          ];
          return {
            content: `Dry run: Would ${parsed.action} firewall ${label} rule with comment "${comment}".`,
            structuredContent: {
              action: "dry_run",
              diff,
              autoRevert: plannedAutoRevert(parsed.autoRevertSeconds),
            },
          };
        }

        const { extra, note } = await applyWrite(
          context,
          parsed.autoRevertSeconds,
          path,
          { kind: "set-disabled", id: String(id), disabled: isDisabled },
          `${parsed.action} ${label} rule "${comment}"`,
          () =>
            context.routerClient.update(path, id, { disabled: wantDisabled ? "true" : "false" }),
        );

        log.info({ id, comment, action: parsed.action }, "Firewall rule toggled");

        return {
          content: `${parsed.action === "disable" ? "Disabled" : "Enabled"} firewall ${label} rule with comment "${comment}".${note}`,
          structuredContent: { action: parsed.action, id, comment, ...extra },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, remove, disable, enable, move.",
        },
      });
    } catch (err) {
      throw toolError(err, context, "manage_firewall_rule");
    }
  },
};

export const firewallTools: ToolDefinition[] = [listFirewallRulesTool, manageFirewallRuleTool];

// ---------------------------------------------------------------------------
// MikroMCP - Moving a rule within an ordered firewall table (filter, nat, raw, mangle)
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolContext } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { isTrue } from "../../adapter/response-parser.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

const ROS_ID = /^\*[0-9A-Fa-f]+$/;

export const moveRuleId = z
  .string()
  .regex(ROS_ID, "Must be a RouterOS rule id such as *1A")
  .optional()
  .describe("Rule to move, by its RouterOS .id (e.g. *1A, from the list tool); move only");

export const moveDestination = z
  .union([z.literal("end"), z.string().regex(ROS_ID, "Must be a RouterOS rule id or end")])
  .optional()
  .describe(
    "Where to move the rule: the .id of the rule to place it before, or end for the bottom of the table; move only",
  );

/** A move worked out against the table as it is now. Positions are 0-based list indexes. */
export interface MovePlan {
  id: string;
  destination: string;
  from: number;
  to: number;
  /** The first static rule after the moved one before the move; absent when it was last. */
  previousNext?: string;
  /** The rule already sits where the move would put it. */
  noChange: boolean;
}

export interface MoveLabels {
  /** e.g. "filter rule", "ipv6 raw rule", "mangle rule" */
  rule: string;
  notFoundCode: string;
  listTool: string;
}

function notFound(labels: MoveLabels, what: string, id: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.NOT_FOUND,
    code: labels.notFoundCode,
    message: `No ${labels.rule} with id ${id} (${what}).`,
    details: { [what]: id },
    recoverability: {
      retryable: false,
      suggestedAction: `List the table with ${labels.listTool} and use a current .id; ids change when rules are re-created.`,
      alternativeTools: [labels.listTool],
    },
  });
}

function dynamicRule(labels: MoveLabels, what: string, id: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "DYNAMIC_RULE_NOT_MOVABLE",
    message: `${labels.rule} ${id} (${what}) is dynamic: RouterOS manages its position and it cannot be moved or used as a move destination.`,
    details: { [what]: id },
    recoverability: {
      retryable: false,
      suggestedAction:
        what === "ruleId"
          ? "Move a static rule instead."
          : "Use the .id of a static rule as destination, or end.",
    },
  });
}

/**
 * Check a move against the table and work out where the rule goes. A rule counts
 * as already placed when the first static rule after it is `destination`, or, for
 * `end`, when no static rule follows it: dynamic rules cannot be moved or anchor a
 * move, so they do not count.
 */
export async function planMove(
  context: ToolContext,
  path: string,
  id: string,
  destination: string,
  labels: MoveLabels,
): Promise<MovePlan> {
  const rules = await context.routerClient.get<RouterOSRecord>(path, {});
  const from = rules.findIndex((r) => r[".id"] === id);
  if (from < 0) throw notFound(labels, "ruleId", id);
  if (isTrue(rules[from].dynamic)) throw dynamicRule(labels, "ruleId", id);

  if (destination !== "end") {
    if (destination === id) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "MOVE_DESTINATION_IS_RULE",
        message: "destination is the rule being moved; a rule cannot be placed before itself.",
        details: { ruleId: id, destination },
        recoverability: {
          retryable: false,
          suggestedAction: "Use the .id of the rule it should precede, or end.",
        },
      });
    }
    const anchor = rules.find((r) => r[".id"] === destination);
    if (!anchor) throw notFound(labels, "destination", destination);
    if (isTrue(anchor.dynamic)) throw dynamicRule(labels, "destination", destination);
  }

  const next = rules.slice(from + 1).find((r) => !isTrue(r.dynamic));
  const previousNext = next === undefined ? undefined : String(next[".id"]);
  const rest = rules.filter((r) => r[".id"] !== id);
  const to = destination === "end" ? rest.length : rest.findIndex((r) => r[".id"] === destination);

  return {
    id,
    destination,
    from,
    to,
    previousNext,
    noChange: destination === "end" ? previousNext === undefined : previousNext === destination,
  };
}

/**
 * Run RouterOS `move`. Without `destination` RouterOS moves the rule to the end of
 * the list (console `move`: the second argument is the item to place before).
 */
export async function executeMove(context: ToolContext, path: string, plan: MovePlan) {
  await context.routerClient.execute(
    `${path}/move`,
    plan.destination === "end"
      ? { numbers: plan.id }
      : { numbers: plan.id, destination: plan.destination },
  );
}

/** structuredContent fields shared by every move outcome. */
export function moveDetails(plan: MovePlan): Record<string, unknown> {
  return {
    id: plan.id,
    destination: plan.destination,
    position: { before: plan.from, after: plan.noChange ? plan.from : plan.to },
  };
}

/** The VALIDATION error for a parameter given with an action it does not apply to. */
export function notForAction(
  param: string,
  action: string,
  suggestedAction: string,
): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "PARAM_NOT_APPLICABLE",
    message: `${param} does not apply to action ${action}.`,
    details: { param, action },
    recoverability: { retryable: false, suggestedAction },
  });
}

/** The VALIDATION error for a parameter an action needs. */
export function requiredForAction(param: string, action: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "PARAM_REQUIRED",
    message: `${param} is required when action is ${action}.`,
    details: { param, action },
    recoverability: { retryable: false, suggestedAction: `Provide ${param}.` },
  });
}

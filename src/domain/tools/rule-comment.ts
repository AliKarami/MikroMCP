// ---------------------------------------------------------------------------
// MikroMCP - Comment as a rule's idempotency key (firewall, mangle)
// ---------------------------------------------------------------------------

import type { ToolContext } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

/**
 * Strip control characters from a comment used as an idempotency key, and
 * reject one that ends up empty: a REST lookup with `?comment=` matches no rule,
 * not even one without a comment (RouterOS 7.24.2), so an add would duplicate
 * on every call and remove would never find the rule.
 */
export function ruleCommentKey(comment: string): string {
  const sanitized = comment.replace(/[\x00-\x1f\x7f]/g, "");
  if (sanitized === "") {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "COMMENT_EMPTY",
      message: "comment is empty after removing control characters.",
      details: { comment },
      recoverability: {
        retryable: false,
        suggestedAction: "Use a comment with printable characters.",
      },
    });
  }
  return sanitized;
}

/** First rule at `path` whose comment equals `comment`, or undefined. */
export async function findRuleByComment(
  context: ToolContext,
  path: string,
  comment: string,
): Promise<Record<string, string> | undefined> {
  const results = await context.routerClient.get<RouterOSRecord>(path, {
    filter: { comment },
  });
  return results.length > 0 ? (results[0] as Record<string, string>) : undefined;
}

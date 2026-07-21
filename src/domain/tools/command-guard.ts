import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import type { RouterConfig } from "../../types.js";
import { globMatch } from "../../util/glob.js";

// Best-effort defense-in-depth, NOT a security boundary. RouterOS command
// syntax has many equivalent spellings (path vs space separators, command
// abbreviation like `/sys reboot`, `:execute`, scripting) and an agent that
// can create+run scripts can run anything regardless. These patterns catch the
// obvious destructive commands and steer callers to dedicated, confirmation-
// gated tools; do not rely on them as an authorization control.
export const BUILTIN_DENY_PATTERNS: string[] = [
  "/system shutdown*",
  "/system reboot*",
  "/system reset-configuration*",
  "/user set*",
  "/user add*",
  "/user remove*",
  "/ip service set*",
  "/certificate*private-key*",
  "/system package uninstall*",
  "/system routerboard upgrade*",
  // Block indirection primitives that would otherwise smuggle a denied command
  // past a segment-wise check.
  "*:execute*",
  "*:parse*",
];

const DENIED_TOOL_SUGGESTIONS: Record<string, string> = {
  "/system reboot*": "reboot",
};

/**
 * Fold a RouterOS command (or a deny/allow glob) into a canonical form so that
 * equivalent spellings compare equal: `/` and whitespace are both separators,
 * runs collapse to a single space, and the leading separator is dropped. This
 * makes `/system/reboot`, `/system reboot`, and `  /system   reboot` identical.
 */
export function normalizeCommand(raw: string): string {
  return raw
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a command line into independently-checked segments on `;` and newlines. */
function segments(raw: string): string[] {
  return raw
    .split(/[;\n]/)
    .map((s) => normalizeCommand(s))
    .filter(Boolean);
}

export interface CommandPolicy {
  allow: string[];
  deny: string[];
}

export function resolveCommandPolicy(
  routerConfig: RouterConfig,
  globalAllow: string[],
  globalDeny: string[],
): CommandPolicy {
  const routerDeny = routerConfig.cmdDeny ?? [];
  const routerAllow = routerConfig.cmdAllow ?? [];

  return {
    deny: [...BUILTIN_DENY_PATTERNS, ...globalDeny, ...routerDeny],
    allow: routerAllow.length > 0 ? routerAllow : globalAllow,
  };
}

export function checkCommand(command: string, policy: CommandPolicy): void {
  const normSegs = segments(command);

  for (const pattern of policy.deny) {
    const normPattern = normalizeCommand(pattern);
    if (normSegs.some((seg) => globMatch(normPattern, seg))) {
      const suggestedTool = DENIED_TOOL_SUGGESTIONS[pattern];
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "COMMAND_DENIED",
        message: `Command denied by policy: matches deny pattern "${pattern}"`,
        details: { command, pattern },
        recoverability: {
          retryable: false,
          suggestedAction: suggestedTool
            ? `Use the dedicated "${suggestedTool}" tool instead.`
            : "Use a dedicated tool for this operation if available.",
          alternativeTools: suggestedTool ? [suggestedTool] : [],
        },
      });
    }
  }

  if (policy.allow.length > 0) {
    const normAllow = policy.allow.map((p) => normalizeCommand(p));
    const everySegmentAllowed = normSegs.every((seg) =>
      normAllow.some((p) => globMatch(p, seg)),
    );
    if (!everySegmentAllowed) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "COMMAND_NOT_ALLOWED",
        message: "Command not in allow list",
        details: { command, allowPatterns: policy.allow },
        recoverability: {
          retryable: false,
          suggestedAction: "The command does not match any pattern in the configured allow list.",
        },
      });
    }
  }
}

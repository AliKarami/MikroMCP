import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import type { RouterConfig } from "../../types.js";

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
];

const DENIED_TOOL_SUGGESTIONS: Record<string, string> = {
  "/system reboot*": "reboot",
};

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
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
  for (const pattern of policy.deny) {
    if (globMatch(pattern, command)) {
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
    const allowed = policy.allow.some((p) => globMatch(p, command));
    if (!allowed) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "COMMAND_NOT_ALLOWED",
        message: `Command not in allow list`,
        details: { command, allowPatterns: policy.allow },
        recoverability: {
          retryable: false,
          suggestedAction: "The command does not match any pattern in the configured allow list.",
        },
      });
    }
  }
}

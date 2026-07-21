import type { Identity } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { globMatch } from "../util/glob.js";

function matchesPattern(name: string, pattern: string): boolean {
  return globMatch(pattern, name);
}

export function checkAuthz(identity: Identity, toolName: string, routerId: string): void {
  if (identity.allowedRouters.length > 0 && !identity.allowedRouters.includes(routerId)) {
    throw new MikroMCPError({
      category: ErrorCategory.PERMISSION_DENIED,
      code: "ROUTER_NOT_ALLOWED",
      message: `Identity "${identity.id}" is not allowed to access router "${routerId}".`,
      details: { identityId: identity.id, routerId, allowedRouters: identity.allowedRouters },
      recoverability: {
        retryable: false,
        suggestedAction: `Add "${routerId}" to allowedRouters for identity "${identity.id}" in identities.yaml.`,
      },
    });
  }

  if (identity.allowedToolPatterns.length > 0) {
    const allowed = identity.allowedToolPatterns.some((p) => matchesPattern(toolName, p));
    if (!allowed) {
      throw new MikroMCPError({
        category: ErrorCategory.PERMISSION_DENIED,
        code: "TOOL_NOT_ALLOWED",
        message: `Identity "${identity.id}" is not allowed to call tool "${toolName}".`,
        details: { identityId: identity.id, toolName, allowedToolPatterns: identity.allowedToolPatterns },
        recoverability: {
          retryable: false,
          suggestedAction: `Add a matching pattern to allowedToolPatterns for identity "${identity.id}" in identities.yaml.`,
        },
      });
    }
  }
}

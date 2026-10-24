// ---------------------------------------------------------------------------
// MikroMCP - Name rules for interfaces this server creates (VLAN, bridge)
// ---------------------------------------------------------------------------

import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

export const NEW_INTERFACE_NAME_MAX = 64;
const NEW_INTERFACE_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Check a name for an interface about to be created. These are MikroMCP's own
 * conservative rules, stricter than RouterOS: apply them only on create, never to
 * actions that reference an existing interface, which must take any name RouterOS
 * already accepted verbatim.
 */
export function assertNewInterfaceName(
  name: string,
  opts: { kind: string; action: string; code: string },
): void {
  const tooLong = name.length > NEW_INTERFACE_NAME_MAX;
  if (!tooLong && NEW_INTERFACE_NAME_PATTERN.test(name)) return;

  throw new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: opts.code,
    message: tooLong
      ? `${opts.kind} name is ${name.length} chars; ${opts.action} allows at most ${NEW_INTERFACE_NAME_MAX}.`
      : `${opts.kind} name "${name}" uses characters ${opts.action} does not allow (permitted: letters, digits, dot, hyphen, underscore).`,
    details: { name },
    recoverability: {
      retryable: false,
      suggestedAction: `Use a name of letters, digits, dot, hyphen or underscore, at most ${NEW_INTERFACE_NAME_MAX} chars.`,
    },
  });
}

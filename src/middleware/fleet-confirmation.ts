import { createHmac, createHash } from "node:crypto";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

interface PendingFleetConfirmation {
  expiresAt: Date;
  fingerprint: string;
}

const pending = new Map<string, PendingFleetConfirmation>();

export interface FleetConfirmationArgs {
  toolName: string;
  routerIds: string[];
  params: Record<string, unknown>;
  identityId: string;
  submittedToken: string | undefined;
}

function fingerprint(args: FleetConfirmationArgs): string {
  const sortedRouters = [...args.routerIds].sort();
  const payload = JSON.stringify({
    toolName: args.toolName,
    routerIds: sortedRouters,
    params: args.params,
    identityId: args.identityId,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function evictExpired(): void {
  const now = new Date();
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

/**
 * Two-step confirmation for fleet-wide destructive operations.
 * First call (no token) throws APPROVAL_REQUIRED carrying a token.
 * Second call with the matching token for the identical fleet/params returns void.
 */
export function checkFleetConfirmation(args: FleetConfirmationArgs, secret: string): void {
  evictExpired();
  const fp = fingerprint(args);

  if (args.submittedToken) {
    const entry = pending.get(args.submittedToken);
    if (!entry || entry.expiresAt <= new Date() || entry.fingerprint !== fp) {
      throw new MikroMCPError({
        category: ErrorCategory.PERMISSION_DENIED,
        code: "FLEET_CONFIRMATION_MISMATCH",
        message:
          "Fleet confirmation token is expired, already used, or does not match the current toolName/routerIds/params.",
        recoverability: {
          retryable: true,
          suggestedAction: "Re-submit bulk_execute without confirmationToken to get a fresh token.",
        },
      });
    }
    pending.delete(args.submittedToken);
    return;
  }

  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const token = createHmac("sha256", secret)
    .update(`${fp}:${expiresAt.toISOString()}`)
    .digest("hex");
  pending.set(token, { expiresAt, fingerprint: fp });

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "FLEET_CONFIRMATION_REQUIRED",
    message: `This will run destructive tool "${args.toolName}" across ${args.routerIds.length} router(s). Re-submit with confirmationToken to proceed.`,
    details: {
      confirmationToken: token,
      expiresAt: expiresAt.toISOString(),
      routerCount: args.routerIds.length,
    },
    recoverability: {
      retryable: true,
      suggestedAction: "Re-submit the identical bulk_execute call with details.confirmationToken.",
    },
  });
}

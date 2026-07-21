import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

// Replay protection only (single-instance) — see confirmation.ts for the
// multi-instance limitation.
const usedTokens = new Map<string, number>();

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

function sign(fp: string, expiresAtMs: number, secret: string): string {
  const mac = createHmac("sha256", secret).update(`${fp}|${expiresAtMs}`).digest("hex");
  return `${expiresAtMs}.${mac}`;
}

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sweepUsed(now: number): void {
  for (const [token, expiresAtMs] of usedTokens) {
    if (expiresAtMs <= now) usedTokens.delete(token);
  }
}

/** Test helper — clear the replay cache. */
export function _resetForTests(): void {
  usedTokens.clear();
}

/**
 * Two-step confirmation for fleet-wide destructive operations.
 * First call (no token) throws APPROVAL_REQUIRED carrying a self-verifying token.
 * Second call with the matching token for the identical fleet/params returns void.
 */
export function checkFleetConfirmation(args: FleetConfirmationArgs, secret: string): void {
  const now = Date.now();
  sweepUsed(now);
  const fp = fingerprint(args);

  if (args.submittedToken) {
    const token = args.submittedToken;
    const dot = token.indexOf(".");
    const expiresAtMs = dot > 0 ? Number(token.slice(0, dot)) : NaN;
    const expected = Number.isFinite(expiresAtMs) ? sign(fp, expiresAtMs, secret) : "";

    if (
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= now ||
      usedTokens.has(token) ||
      !tokensEqual(token, expected)
    ) {
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
    usedTokens.set(token, expiresAtMs);
    return;
  }

  const expiresAtMs = now + CONFIRMATION_TTL_MS;
  const token = sign(fp, expiresAtMs, secret);

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "FLEET_CONFIRMATION_REQUIRED",
    message: `This will run destructive tool "${args.toolName}" across ${args.routerIds.length} router(s). Re-submit with confirmationToken to proceed.`,
    details: {
      confirmationToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      routerCount: args.routerIds.length,
    },
    recoverability: {
      retryable: true,
      suggestedAction: "Re-submit the identical bulk_execute call with details.confirmationToken.",
    },
  });
}

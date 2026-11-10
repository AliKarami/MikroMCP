import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { NO_STATE_FINGERPRINT } from "../domain/snapshot/state-fingerprint.js";
import {
  formatToken,
  newNonce,
  parseToken,
  stateChangedError,
  type TokenParts,
} from "./confirmation.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

// Used when MIKROMCP_CONFIRMATION_SECRET is unset, so fleet writes are always
// gated. Its tokens verify only in this process and die with it.
const processSecret = randomBytes(32).toString("hex");

// Replay protection only (single-instance) — see confirmation.ts for the
// multi-instance limitation.
const usedTokens = new Map<string, number>();

export interface FleetConfirmationArgs {
  toolName: string;
  routerIds: string[];
  params: Record<string, unknown>;
  identityId: string;
  submittedToken: string | undefined;
  /**
   * Fingerprint of the affected configuration across the targeted routers, read
   * now (see fleetStateFingerprint in fleet-tools.ts). Omitted, nothing is bound.
   */
  stateFingerprint?: string;
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

function sign(fp: string, parts: TokenParts, secret: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${fp}|${parts.stateFingerprint}|${parts.nonce}|${parts.expiresAtMs}`)
    .digest("hex");
  return formatToken(parts, mac);
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
 * Two-step confirmation for fleet-wide write operations.
 * First call (no token) throws APPROVAL_REQUIRED carrying a self-verifying token.
 * Second call with the matching token for the identical fleet/params returns void.
 */
export function checkFleetConfirmation(
  args: FleetConfirmationArgs,
  configuredSecret: string | undefined,
): void {
  const secret = configuredSecret ?? processSecret;
  const now = Date.now();
  sweepUsed(now);
  const fp = fingerprint(args);
  const currentState = args.stateFingerprint ?? NO_STATE_FINGERPRINT;

  if (args.submittedToken) {
    const token = args.submittedToken;
    const parts = parseToken(token);
    const { expiresAtMs, stateFingerprint } = parts;
    const expected = Number.isFinite(expiresAtMs) ? sign(fp, parts, secret) : "";

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
    if (stateFingerprint !== currentState) {
      throw stateChangedError(`at least one of the ${args.routerIds.length} targeted router(s)`);
    }
    usedTokens.set(token, expiresAtMs);
    return;
  }

  const expiresAtMs = now + CONFIRMATION_TTL_MS;
  const token = sign(
    fp,
    { expiresAtMs, nonce: newNonce(), stateFingerprint: currentState },
    secret,
  );

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "FLEET_CONFIRMATION_REQUIRED",
    message: `This will run write tool "${args.toolName}" across ${args.routerIds.length} router(s). Re-submit with confirmationToken to proceed.`,
    details: {
      confirmationToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      routerCount: args.routerIds.length,
      stateFingerprint: currentState,
    },
    recoverability: {
      retryable: true,
      suggestedAction: "Re-submit the identical bulk_execute call with details.confirmationToken.",
    },
  });
}

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Identity } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { NO_STATE_FINGERPRINT } from "../domain/snapshot/state-fingerprint.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const BYPASS_ROLES: Identity["role"][] = ["admin", "superadmin"];

// Replay protection only: a self-verifying token stays valid until it expires,
// so this records which tokens were already consumed to enforce single use.
// Single-instance only — a multi-instance HTTP deployment can replay a token
// against a sibling process within its TTL (documented limitation).
const usedTokens = new Map<string, number>();

function computeParamHash(params: Record<string, unknown>): string {
  const { confirmationToken: _, ...rest } = params;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export interface TokenParts {
  expiresAtMs: number;
  /** Random per issue, so two identical requests in the same millisecond get distinct single-use tokens. */
  nonce: string;
  stateFingerprint: string;
}

export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Token layout: `<expiresAtMs>.<nonce>.<stateFingerprint>.<mac>`. The state
 * fingerprint travels in the clear (it is a hash) and is covered by the MAC,
 * so a verifier can tell "different request" from "same request, but the
 * router changed since the preview".
 */
export function formatToken(parts: TokenParts, mac: string): string {
  return `${parts.expiresAtMs}.${parts.nonce}.${parts.stateFingerprint}.${mac}`;
}

/** Split a token into its parts; expiresAtMs is NaN when the token is malformed. */
export function parseToken(token: string): TokenParts {
  const parts = token.split(".");
  if (parts.length !== 4 || parts.slice(0, 3).some((p) => p === "")) {
    return { expiresAtMs: NaN, nonce: "", stateFingerprint: "" };
  }
  return { expiresAtMs: Number(parts[0]), nonce: parts[1], stateFingerprint: parts[2] };
}

function sign(
  tool: string,
  routerId: string,
  identityId: string,
  paramHash: string,
  parts: TokenParts,
  secret: string,
): string {
  const payload = `${tool}|${routerId}|${identityId}|${paramHash}|${parts.stateFingerprint}|${parts.nonce}|${parts.expiresAtMs}`;
  return formatToken(parts, createHmac("sha256", secret).update(payload).digest("hex"));
}

export function stateChangedError(scope: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.CONFLICT,
    code: "CONFIRMATION_STATE_CHANGED",
    message: `The configuration this confirmation was issued against has changed on ${scope} since the preview. The token approves the state that was previewed, not the current one.`,
    recoverability: {
      retryable: true,
      suggestedAction:
        "Review the current state (re-run the dry run), then re-submit without confirmationToken to get a token for it.",
    },
  });
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

export async function checkConfirmation(
  toolName: string,
  routerId: string,
  params: Record<string, unknown>,
  identity: Identity,
  secret: string,
  readStateFingerprint: () => Promise<string> = async () => NO_STATE_FINGERPRINT,
): Promise<void> {
  if (BYPASS_ROLES.includes(identity.role)) return;

  const now = Date.now();
  sweepUsed(now);

  const submittedToken =
    typeof params.confirmationToken === "string" ? params.confirmationToken : null;
  const paramHash = computeParamHash(params);

  if (submittedToken) {
    const parts = parseToken(submittedToken);
    const { expiresAtMs, stateFingerprint } = parts;

    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || usedTokens.has(submittedToken)) {
      throw new MikroMCPError({
        category: ErrorCategory.PERMISSION_DENIED,
        code: "CONFIRMATION_EXPIRED",
        message:
          "Confirmation token has expired or was already used. Re-submit without confirmationToken to get a fresh token.",
        recoverability: {
          retryable: true,
          suggestedAction:
            "Re-submit the tool call without confirmationToken to receive a new token.",
        },
      });
    }

    const expected = sign(toolName, routerId, identity.id, paramHash, parts, secret);
    if (!tokensEqual(submittedToken, expected)) {
      throw new MikroMCPError({
        category: ErrorCategory.PERMISSION_DENIED,
        code: "CONFIRMATION_MISMATCH",
        message: "Confirmation token does not match the current call parameters.",
        recoverability: {
          retryable: true,
          suggestedAction:
            "Re-submit the tool call without confirmationToken to receive a new token.",
        },
      });
    }

    // Checked after the MAC, so a forged token costs no router reads. Not
    // consumed on a mismatch: should the state return to what was previewed
    // within the TTL, the approval holds again.
    if ((await readStateFingerprint()) !== stateFingerprint) {
      throw stateChangedError(`router "${routerId}"`);
    }

    usedTokens.set(submittedToken, expiresAtMs);
    return;
  }

  const expiresAtMs = now + CONFIRMATION_TTL_MS;
  const stateFingerprint = await readStateFingerprint();
  const token = sign(
    toolName,
    routerId,
    identity.id,
    paramHash,
    { expiresAtMs, nonce: newNonce(), stateFingerprint },
    secret,
  );

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "CONFIRMATION_REQUIRED",
    message: "This action is destructive. Re-submit with confirmationToken to proceed.",
    details: {
      confirmationToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      tool: toolName,
      routerId,
      stateFingerprint,
    },
    recoverability: {
      retryable: true,
      suggestedAction:
        "Re-submit the exact same tool call with the confirmationToken from details.confirmationToken. The token is bound to the router's current configuration: if it changes before you re-submit, the call is refused with CONFIRMATION_STATE_CHANGED.",
    },
  });
}

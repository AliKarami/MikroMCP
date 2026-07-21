import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { Identity } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

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

function sign(
  tool: string,
  routerId: string,
  identityId: string,
  paramHash: string,
  expiresAtMs: number,
  secret: string,
): string {
  const payload = `${tool}|${routerId}|${identityId}|${paramHash}|${expiresAtMs}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
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

export async function checkConfirmation(
  toolName: string,
  routerId: string,
  params: Record<string, unknown>,
  identity: Identity,
  secret: string,
): Promise<void> {
  if (BYPASS_ROLES.includes(identity.role)) return;

  const now = Date.now();
  sweepUsed(now);

  const submittedToken =
    typeof params.confirmationToken === "string" ? params.confirmationToken : null;
  const paramHash = computeParamHash(params);

  if (submittedToken) {
    const dot = submittedToken.indexOf(".");
    const expiresAtMs = dot > 0 ? Number(submittedToken.slice(0, dot)) : NaN;

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

    const expected = sign(toolName, routerId, identity.id, paramHash, expiresAtMs, secret);
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

    usedTokens.set(submittedToken, expiresAtMs);
    return;
  }

  const expiresAtMs = now + CONFIRMATION_TTL_MS;
  const token = sign(toolName, routerId, identity.id, paramHash, expiresAtMs, secret);

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "CONFIRMATION_REQUIRED",
    message: "This action is destructive. Re-submit with confirmationToken to proceed.",
    details: {
      confirmationToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      tool: toolName,
      routerId,
    },
    recoverability: {
      retryable: true,
      suggestedAction:
        "Re-submit the exact same tool call with the confirmationToken from details.confirmationToken.",
    },
  });
}

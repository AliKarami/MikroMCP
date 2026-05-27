import { createHmac, createHash } from "node:crypto";
import type { Identity } from "../types.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const BYPASS_ROLES: Identity["role"][] = ["admin", "superadmin"];

interface PendingConfirmation {
  expiresAt: Date;
  tool: string;
  routerId: string;
  identityId: string;
  paramHash: string;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

function computeParamHash(params: Record<string, unknown>): string {
  const { confirmationToken: _, ...rest } = params;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

function computeToken(
  tool: string,
  routerId: string,
  identityId: string,
  paramHash: string,
  expiresAt: string,
  secret: string,
): string {
  const payload = JSON.stringify({ tool, routerId, paramHash, identityId, expiresAt });
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function evictExpired(): void {
  const now = new Date();
  for (const [token, entry] of pendingConfirmations) {
    if (entry.expiresAt <= now) pendingConfirmations.delete(token);
  }
}

export async function checkConfirmation(
  toolName: string,
  routerId: string,
  params: Record<string, unknown>,
  identity: Identity,
  secret: string,
): Promise<void> {
  if (BYPASS_ROLES.includes(identity.role)) return;

  evictExpired();

  const submittedToken = typeof params.confirmationToken === "string" ? params.confirmationToken : null;

  if (submittedToken) {
    const entry = pendingConfirmations.get(submittedToken);

    if (!entry || entry.expiresAt <= new Date()) {
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

    const currentParamHash = computeParamHash(params);
    if (
      entry.tool !== toolName ||
      entry.routerId !== routerId ||
      entry.identityId !== identity.id ||
      entry.paramHash !== currentParamHash
    ) {
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

    pendingConfirmations.delete(submittedToken);
    return;
  }

  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
  const paramHash = computeParamHash(params);
  const token = computeToken(toolName, routerId, identity.id, paramHash, expiresAt, secret);

  pendingConfirmations.set(token, {
    expiresAt: new Date(expiresAt),
    tool: toolName,
    routerId,
    identityId: identity.id,
    paramHash,
  });

  throw new MikroMCPError({
    category: ErrorCategory.APPROVAL_REQUIRED,
    code: "CONFIRMATION_REQUIRED",
    message: "This action is destructive. Re-submit with confirmationToken to proceed.",
    details: {
      confirmationToken: token,
      expiresAt,
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

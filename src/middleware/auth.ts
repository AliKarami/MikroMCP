import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { Identity } from "../types.js";
import type { IdentityRegistry } from "../config/identity-registry.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

const identityStorage = new AsyncLocalStorage<Identity>();

export function getCurrentIdentity(): Identity | undefined {
  return identityStorage.getStore();
}

export function withIdentity<T>(identity: Identity, fn: () => T | Promise<T>): T | Promise<T> {
  return identityStorage.run(identity, fn);
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer (.+)$/i.exec(authHeader);
  return match ? match[1] : null;
}

export async function authenticateHttp(
  req: IncomingMessage,
  registry: IdentityRegistry,
): Promise<Identity> {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    throw new MikroMCPError({
      category: ErrorCategory.PERMISSION_DENIED,
      code: "INVALID_TOKEN",
      message: "Missing or malformed Authorization header. Use: Authorization: Bearer <token>",
      recoverability: {
        retryable: false,
        suggestedAction: "Provide a valid bearer token in the Authorization header.",
      },
    });
  }

  const identity = await registry.findIdentityByToken(token);
  if (!identity) {
    throw new MikroMCPError({
      category: ErrorCategory.PERMISSION_DENIED,
      code: "INVALID_TOKEN",
      message: "Token does not match any configured identity.",
      recoverability: {
        retryable: false,
        suggestedAction: "Verify the bearer token matches a configured identity in identities.yaml.",
      },
    });
  }

  return identity;
}

const BUILTIN_SUPERADMIN: Identity = {
  id: "superadmin-builtin",
  role: "superadmin",
  allowedRouters: [],
  allowedToolPatterns: [],
};

export function getStdioIdentity(
  stdioIdentityName: string | undefined,
  registry: IdentityRegistry,
): Identity {
  if (!stdioIdentityName) {
    return BUILTIN_SUPERADMIN;
  }

  const found = registry.getIdentities().find((i) => i.id === stdioIdentityName);
  if (!found) {
    throw new MikroMCPError({
      category: ErrorCategory.CONFIGURATION,
      code: "STDIO_IDENTITY_NOT_FOUND",
      message: `MIKROMCP_STDIO_IDENTITY="${stdioIdentityName}" was not found in identities.yaml`,
      details: { stdioIdentityName },
      recoverability: {
        retryable: false,
        suggestedAction: `Add an identity named "${stdioIdentityName}" to config/identities.yaml or unset MIKROMCP_STDIO_IDENTITY.`,
      },
    });
  }

  return found;
}

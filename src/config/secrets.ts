// ---------------------------------------------------------------------------
// MikroMCP - Credential isolation
// ---------------------------------------------------------------------------

import type { RouterConfig } from "../types.js";
import {
  MikroMCPError,
  ErrorCategory,
} from "../domain/errors/error-types.js";

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Retrieve credentials for the given router configuration.
 *
 * - source="env": reads `{envPrefix}_USER` and `{envPrefix}_PASS` from the
 *   process environment. Throws a CONFIGURATION error if either is missing.
 * - source="vault": not yet supported; throws a CONFIGURATION error.
 *
 * Credentials are never logged.
 */
export function getCredentials(router: RouterConfig): Credentials {
  const { source, envPrefix, vaultPath } = router.credentials;

  if (source === "vault") {
    throw new MikroMCPError({
      category: ErrorCategory.CONFIGURATION,
      code: "VAULT_NOT_SUPPORTED",
      message: `Vault credential source is not supported in v0.1 (vaultPath=${vaultPath ?? "n/a"})`,
      recoverability: {
        retryable: false,
        suggestedAction:
          'Switch to source="env" and provide credentials via environment variables.',
      },
    });
  }

  if (!envPrefix) {
    throw new MikroMCPError({
      category: ErrorCategory.CONFIGURATION,
      code: "MISSING_ENV_PREFIX",
      message: `Router "${router.id}" uses source="env" but no envPrefix is configured`,
      recoverability: {
        retryable: false,
        suggestedAction: "Set envPrefix in the router configuration.",
      },
    });
  }

  const userKey = `${envPrefix}_USER`;
  const passKey = `${envPrefix}_PASS`;

  const username = process.env[userKey];
  const password = process.env[passKey];

  if (!username || !password) {
    const missing = [
      !username ? userKey : null,
      !password ? passKey : null,
    ].filter(Boolean);

    throw new MikroMCPError({
      category: ErrorCategory.CONFIGURATION,
      code: "MISSING_CREDENTIALS",
      message: `Missing environment variable(s) for router "${router.id}": ${missing.join(", ")}`,
      details: { missing },
      recoverability: {
        retryable: false,
        suggestedAction: `Set the ${missing.join(" and ")} environment variable(s).`,
      },
    });
  }

  return { username, password };
}

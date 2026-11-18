import type { AppConfig } from "./app-config.js";
import type { IdentityChanges, IdentityRegistry } from "./identity-registry.js";
import type { RouterChanges, RouterRegistry } from "./router-registry.js";
import type { ConnectionPool } from "../adapter/connection-pool.js";
import type { CircuitBreaker } from "../adapter/circuit-breaker.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("config-reload");

export interface ReloadDeps {
  routerRegistry: RouterRegistry;
  identityRegistry: IdentityRegistry;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
  config: Pick<AppConfig, "transport" | "confirmationSecret">;
}

export interface ReloadResult {
  applied: boolean;
  routers: RouterChanges;
  identities: IdentityChanges;
}

/**
 * Re-read routers.yaml and identities.yaml. Both files are read and checked
 * before either registry changes, so a bad file leaves everything as it was
 * (the error is thrown). Pooled clients and circuit breakers of routers that
 * changed or went away are dropped, so the next call connects with the new
 * settings and a router that was failing starts with a clean breaker.
 */
export function reloadConfig(deps: ReloadDeps, dryRun = false): ReloadResult {
  const routers = deps.routerRegistry.prepareReload();
  const identities = deps.identityRegistry.prepareReload();

  // The startup rule, applied again: limited roles cannot confirm a write
  // without the secret that signs confirmation tokens.
  if (deps.config.transport === "http" && !deps.config.confirmationSecret) {
    if (identities.hasLimitedRoles) {
      throw new Error(
        "identities.yaml has identities with role readonly or operator, but MIKROMCP_CONFIRMATION_SECRET is not set (required in HTTP mode); reload refused",
      );
    }
  }

  const result: ReloadResult = {
    applied: !dryRun,
    routers: routers.changes,
    identities: identities.changes,
  };
  if (dryRun) return result;

  routers.commit();
  identities.commit();
  const stale = [...routers.changes.changed.map((c) => c.id), ...routers.changes.removed];
  for (const id of stale) {
    deps.pool.removeClient(id);
    deps.circuitBreakers.delete(id);
  }
  log.info(
    {
      routersAdded: routers.changes.added,
      routersRemoved: routers.changes.removed,
      routersChanged: routers.changes.changed,
      identitiesAdded: identities.changes.added,
      identitiesRemoved: identities.changes.removed,
      identitiesChanged: identities.changes.changed,
    },
    "Configuration reloaded",
  );
  return result;
}

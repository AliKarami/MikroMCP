import { loadAppConfig } from "../config/app-config.js";
import { createServerFactory } from "../mcp/server.js";
import { connectStdio } from "../mcp/transports/stdio.js";
import { connectHttp } from "../mcp/transports/http.js";
import { IdentityRegistry } from "../config/identity-registry.js";
import { reloadConfig } from "../config/reload.js";
import { getStdioIdentity } from "../middleware/auth.js";
import { createLogger } from "../observability/logger.js";
import { pruneSnapshots, rotateAndPruneJournal } from "../domain/snapshot/retention.js";

const log = createLogger("main");

export async function runServe(): Promise<void> {
  const config = loadAppConfig();
  log.info({ transport: config.transport, logLevel: config.logLevel }, "Starting MikroMCP server");

  void pruneSnapshots(config.snapshotDir, config.retention.snapshotMaxAgeDays);
  void rotateAndPruneJournal(config.journalPath, config.retention.snapshotMaxAgeDays);

  const identityRegistry = new IdentityRegistry(config.identitiesPath);

  if (config.transport === "http") {
    const hasLimitedRoles = identityRegistry
      .getIdentities()
      .some((i) => i.role === "readonly" || i.role === "operator");
    if (hasLimitedRoles && !config.confirmationSecret) {
      log.error(
        "MIKROMCP_CONFIRMATION_SECRET is required in HTTP mode when identities with role readonly or operator are configured",
      );
      process.exit(1);
    }
  }

  const { makeServer, pool, circuitBreakers, registry } = createServerFactory(
    config,
    identityRegistry,
  );

  if (config.transport === "stdio") {
    // Fail at startup if the named identity is missing, but do not bind it to
    // the session: the executor looks the stdio identity up on every call, so
    // a reload can demote or remove it.
    getStdioIdentity(config.stdioIdentity, identityRegistry);
    await connectStdio(makeServer());
    log.info("MikroMCP server running via stdio");
  } else if (config.transport === "http") {
    await connectHttp(
      makeServer,
      {
        port: config.port,
        bindHost: config.bindHost,
        maxBodyBytes: config.http.maxBodyBytes,
        rateLimitRpm: config.http.rateLimitRpm,
      },
      identityRegistry,
    );
    log.info(
      { port: config.port, bindHost: config.bindHost },
      "MikroMCP server running via HTTP/SSE",
    );
  }

  const shutdown = () => {
    log.info("Shutting down MikroMCP server");
    pool.closeAll();
    process.exit(0);
  };

  // Windows has no SIGHUP; there reload_config is the way.
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      try {
        reloadConfig({
          routerRegistry: registry,
          identityRegistry,
          pool,
          circuitBreakers,
          config,
        });
      } catch (err) {
        log.error(
          { err },
          "SIGHUP: configuration not reloaded; the running configuration is unchanged",
        );
      }
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

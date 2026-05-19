import { loadAppConfig } from "../config/app-config.js";
import { createServerFactory } from "../mcp/server.js";
import { connectStdio } from "../mcp/transports/stdio.js";
import { connectHttp } from "../mcp/transports/http.js";
import { IdentityRegistry } from "../config/identity-registry.js";
import { getStdioIdentity, withIdentity } from "../middleware/auth.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("main");

export async function runServe(): Promise<void> {
  const config = loadAppConfig();
  log.info({ transport: config.transport, logLevel: config.logLevel }, "Starting MikroMCP server");

  const identityRegistry = new IdentityRegistry(config.identitiesPath);

  if (config.transport === "http") {
    const hasLimitedRoles = identityRegistry.getIdentities().some(
      (i) => i.role === "readonly" || i.role === "operator",
    );
    if (hasLimitedRoles && !config.confirmationSecret) {
      log.error(
        "MIKROMCP_CONFIRMATION_SECRET is required in HTTP mode when identities with role readonly or operator are configured",
      );
      process.exit(1);
    }
  }

  const { makeServer, pool } = createServerFactory(config, identityRegistry);

  if (config.transport === "stdio") {
    const stdioIdentity = getStdioIdentity(config.stdioIdentity, identityRegistry);
    await withIdentity(stdioIdentity, () => connectStdio(makeServer()));
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

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

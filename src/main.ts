// ---------------------------------------------------------------------------
// MikroMCP - Entry point
// ---------------------------------------------------------------------------

import { loadAppConfig } from "./config/app-config.js";
import { createServerFactory } from "./mcp/server.js";
import { connectStdio } from "./mcp/transports/stdio.js";
import { connectHttp } from "./mcp/transports/http.js";
import { IdentityRegistry } from "./config/identity-registry.js";
import { createLogger } from "./observability/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const config = loadAppConfig();
  log.info({ transport: config.transport, logLevel: config.logLevel }, "Starting MikroMCP server");

  const { makeServer, pool } = createServerFactory(config);
  const identityRegistry = new IdentityRegistry(config.identitiesPath);

  if (config.transport === "stdio") {
    await connectStdio(makeServer());
    log.info("MikroMCP server running via stdio");
  } else if (config.transport === "http") {
    await connectHttp(makeServer, {
      port: config.port,
      bindHost: config.bindHost,
      maxBodyBytes: config.http.maxBodyBytes,
      rateLimitRpm: config.http.rateLimitRpm,
    }, identityRegistry);
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

main().catch((err) => {
  console.error("Fatal error starting MikroMCP:", err);
  process.exit(1);
});

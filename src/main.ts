// ---------------------------------------------------------------------------
// MikroMCP - Entry point
// ---------------------------------------------------------------------------

import { loadAppConfig } from "./config/app-config.js";
import { createMcpServer } from "./mcp/server.js";
import { connectStdio } from "./mcp/transports/stdio.js";
import { createLogger } from "./observability/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const config = loadAppConfig();
  log.info({ transport: config.transport, logLevel: config.logLevel }, "Starting MikroMCP server");

  const { server, pool } = createMcpServer(config);

  if (config.transport === "stdio") {
    await connectStdio(server);
    log.info("MikroMCP server running via stdio");
  } else {
    log.error("HTTP transport not yet implemented. Use MIKROMCP_TRANSPORT=stdio");
    process.exit(1);
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

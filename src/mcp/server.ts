// ---------------------------------------------------------------------------
// MikroMCP - MCP server bootstrap
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tool-registry.js";
import { RouterRegistry } from "../config/router-registry.js";
import { ConnectionPool } from "../adapter/connection-pool.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import type { AppConfig } from "../config/app-config.js";
import type { IdentityRegistry } from "../config/identity-registry.js";

export function createServerFactory(
  config: AppConfig,
  identityRegistry: IdentityRegistry,
): {
  makeServer: () => McpServer;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
} {
  const registry = new RouterRegistry(config.configPath);
  const pool = new ConnectionPool();
  const circuitBreakers = new Map<string, CircuitBreaker>();

  const makeServer = (): McpServer => {
    const server = new McpServer({
      name: "mikromcp",
      version: "1.0.10",
    });
    registerAllTools(server, registry, pool, circuitBreakers, config, identityRegistry);
    return server;
  };

  return { makeServer, pool, circuitBreakers };
}

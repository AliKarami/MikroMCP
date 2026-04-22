// ---------------------------------------------------------------------------
// MikroMCP - MCP server bootstrap
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tool-registry.js";
import { RouterRegistry } from "../config/router-registry.js";
import { ConnectionPool } from "../adapter/connection-pool.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import type { AppConfig } from "../config/app-config.js";

export function createMcpServer(config: AppConfig): {
  server: McpServer;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
} {
  const server = new McpServer({
    name: "mikrotik-mcp-server",
    version: "0.1.0",
  });

  const registry = new RouterRegistry(config.configPath);
  const pool = new ConnectionPool();
  const circuitBreakers = new Map<string, CircuitBreaker>();

  registerAllTools(server, registry, pool, circuitBreakers, config);

  return { server, pool, circuitBreakers };
}

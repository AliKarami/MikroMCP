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
import { VERSION } from "../version.js";

/**
 * Always-on guidance sent to MCP clients in the initialize response. Kept short
 * because it costs tokens on every session — the full operating playbook lives in
 * the `mikromcp` usage skill, not here.
 */
export const SERVER_INSTRUCTIONS = [
  "MikroMCP manages MikroTik RouterOS devices.",
  "Reads are safe; treat writes as consequential — preview a write with dryRun:true and review the diff before applying.",
  "Destructive operations may require a two-step confirmation token.",
  "Writes are idempotent: already_exists and no_change are success, not errors.",
  "Prefer dedicated tools over run_command.",
  "routerId is optional when a default router is configured.",
  "For the full operating playbook, install the MikroMCP usage skill.",
].join(" ");

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
    const server = new McpServer(
      {
        name: "mikromcp",
        version: VERSION,
      },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerAllTools(server, registry, pool, circuitBreakers, config, identityRegistry);
    return server;
  };

  return { makeServer, pool, circuitBreakers };
}

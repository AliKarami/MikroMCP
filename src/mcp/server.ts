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
import type { Identity } from "../types.js";
import {
  assertKnownToolsets,
  catalogueNote,
  selectCatalogue,
  toolsForIdentity,
} from "./tool-catalogue.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("server");

/**
 * Always-on guidance sent to MCP clients in the initialize response. Kept short
 * because it costs tokens on every session — the full operating playbook lives in
 * the `mikromcp` usage skill, not here.
 */
export const SERVER_INSTRUCTIONS = [
  "MikroMCP manages MikroTik RouterOS routers and SwOS switches.",
  "Reads are safe; treat writes as consequential — preview a write with dryRun:true and review the diff before applying.",
  "Destructive operations and fleet writes need a two-step confirmation token: on APPROVAL_REQUIRED, tell the user what will change before re-submitting with it.",
  "Writes are idempotent: already_exists and no_change are success, not errors.",
  "Prefer dedicated tools over run_command.",
  "routerId is optional when a default router is configured.",
  "Check list_routers first: swos devices take the swos_* tools, RouterOS devices take everything else.",
  "For the full operating playbook, install the MikroMCP usage skill.",
].join(" ");

export function createServerFactory(
  config: AppConfig,
  identityRegistry: IdentityRegistry,
): {
  /** Builds a server; with an identity, tools/list leaves out what its allowedToolPatterns refuse. */
  makeServer: (identity?: Identity) => McpServer;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
  registry: RouterRegistry;
} {
  const registry = new RouterRegistry(config.configPath);
  const pool = new ConnectionPool();
  const circuitBreakers = new Map<string, CircuitBreaker>();

  const catalogueOptions = { readOnly: config.readOnly, toolsets: config.toolsets };
  assertKnownToolsets(catalogueOptions.toolsets);
  const catalogue = selectCatalogue(catalogueOptions);
  const note = catalogueNote(catalogueOptions);
  const instructions = note ? `${SERVER_INSTRUCTIONS} ${note}` : SERVER_INSTRUCTIONS;
  if (note) log.info({ tools: catalogue.length, ...catalogueOptions }, "Reduced tool catalogue");

  const makeServer = (identity?: Identity): McpServer => {
    const server = new McpServer(
      {
        name: "mikromcp",
        version: VERSION,
      },
      { instructions },
    );
    registerAllTools(
      server,
      toolsForIdentity(catalogue, identity),
      registry,
      pool,
      circuitBreakers,
      config,
      identityRegistry,
    );
    return server;
  };

  return { makeServer, pool, circuitBreakers, registry };
}

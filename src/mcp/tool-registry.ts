import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allTools } from "../domain/tools/index.js";
import { RouterRegistry } from "../config/router-registry.js";
import { ConnectionPool } from "../adapter/connection-pool.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import { createLogger } from "../observability/logger.js";
import type { AppConfig } from "../config/app-config.js";
import type { IdentityRegistry } from "../config/identity-registry.js";
import { executeToolCall, type ToolExecutorDeps } from "./tool-executor.js";

const log = createLogger("tool-registry");

export function registerAllTools(
  server: McpServer,
  registry: RouterRegistry,
  pool: ConnectionPool,
  circuitBreakers: Map<string, CircuitBreaker>,
  config: AppConfig,
  identityRegistry: IdentityRegistry,
): void {
  const deps: ToolExecutorDeps = { registry, pool, circuitBreakers, config, identityRegistry };

  for (const tool of allTools) {
    const registrationSchema = tool.annotations.destructiveHint
      ? (tool.inputSchema as z.ZodObject<z.ZodRawShape>).extend({
          confirmationToken: z.string().optional().describe(
            "Token from a prior APPROVAL_REQUIRED response. Re-submit the identical call with this token to confirm the destructive action.",
          ),
        })
      : tool.inputSchema;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: registrationSchema,
        annotations: tool.annotations,
      },
      (args: Record<string, unknown>) => executeToolCall(tool, args, deps),
    );

    log.debug({ tool: tool.name }, "Registered tool");
  }

  log.info({ count: allTools.length }, "All tools registered");
}

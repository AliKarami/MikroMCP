// ---------------------------------------------------------------------------
// MikroMCP - Tool registration with the MCP server
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "../domain/tools/index.js";
import { RouterRegistry } from "../config/router-registry.js";
import { ConnectionPool } from "../adapter/connection-pool.js";
import { getCredentials } from "../config/secrets.js";
import { withRetry } from "../adapter/retry-engine.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import { enrichError } from "../domain/errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { formatToolResult, formatError } from "./response-formatter.js";
import { createLogger } from "../observability/logger.js";
import { withContext } from "../observability/correlation.js";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config/app-config.js";

const log = createLogger("tool-registry");

export function registerAllTools(
  server: McpServer,
  registry: RouterRegistry,
  pool: ConnectionPool,
  circuitBreakers: Map<string, CircuitBreaker>,
  config: AppConfig,
): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        const correlationId = nanoid();

        return withContext({ correlationId, tool: tool.name }, async () => {
          try {
            const routerId = args.routerId as string | undefined;
            if (!routerId) {
              throw new MikroMCPError({
                category: ErrorCategory.VALIDATION,
                code: "MISSING_ROUTER_ID",
                message: "routerId is required",
                recoverability: {
                  retryable: false,
                  suggestedAction: "Provide a valid routerId parameter.",
                },
              });
            }

            const routerConfig = registry.getRouter(routerId);
            const credentials = getCredentials(routerConfig);
            const client = pool.getClient(routerConfig, credentials);

            // Get or create circuit breaker for this router
            let cb = circuitBreakers.get(routerId);
            if (!cb) {
              cb = new CircuitBreaker(routerId, {
                failureThreshold: config.circuitBreaker.failureThreshold,
                cooldownMs: config.circuitBreaker.cooldownMs,
              });
              circuitBreakers.set(routerId, cb);
            }

            const executeHandler = () =>
              cb!.execute(() =>
                tool.handler(args, { routerClient: client, routerId, correlationId }),
              );

            // Retry only read-only tools
            const result = tool.annotations.readOnlyHint
              ? await withRetry(executeHandler, config.retry)
              : await executeHandler();

            log.info({ tool: tool.name, routerId, correlationId }, "Tool executed successfully");
            return formatToolResult(result);
          } catch (err) {
            const error =
              err instanceof MikroMCPError ? err : enrichError(err, { tool: tool.name });
            log.error({ err: error, tool: tool.name, correlationId }, "Tool execution failed");
            return formatError(error);
          }
        });
      },
    );

    log.debug({ tool: tool.name }, "Registered tool");
  }

  log.info({ count: allTools.length }, "All tools registered");
}

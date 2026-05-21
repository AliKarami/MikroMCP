import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord, RouterConfig } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { auditLog } from "../../observability/audit-log.js";
import { checkAuthz } from "../../middleware/authz.js";
import { buildRouterToolContext } from "../../mcp/tool-context.js";

const log = createLogger("fleet-tools");

const checkHealthInputSchema = z
  .object({
    routerId: z.string().describe("Target router to health-check"),
  })
  .strict();

const bulkExecuteInputSchema = z
  .object({
    toolName: z.string().describe("Name of the tool to fan out (must be a single-router tool)"),
    routerIds: z.array(z.string()).optional().describe("Explicit list of router IDs to target"),
    tags: z.array(z.string()).optional().describe("Target all routers with ALL of these tags (mutually exclusive with routerIds)"),
    params: z
      .record(z.string(), z.unknown())
      .describe("Params to pass to the tool (omit routerId — injected per router)"),
    concurrency: z.number().int().min(1).max(20).default(5).describe("Max simultaneous router calls"),
  })
  .strict();

interface BulkResult {
  routerId: string;
  status: "ok" | "error";
  result?: ToolResult;
  error?: string;
  durationMs: number;
}

export function createFleetTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const toolMap = new Map(baseTools.map((t) => [t.name, t]));

  const checkRouterHealthTool: ToolDefinition = {
    name: "check_router_health",
    title: "Check Router Health",
    description:
      "Probe a router by fetching system/resource. Returns health status, ROS version, uptime, CPU load, and memory info. Unlike other tools, this never throws — unreachable routers are reported as healthy=false.",
    inputSchema: checkHealthInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      checkHealthInputSchema.parse(params);
      log.info({ routerId: context.routerId }, "Checking router health");
      const startMs = Date.now();

      try {
        const resources = await context.routerClient.get<RouterOSRecord>("system/resource");
        const resource = resources[0];
        const latencyMs = Date.now() - startMs;

        const result = {
          routerId: context.routerId,
          healthy: true,
          rosVersion: resource?.["version"] as string | undefined,
          uptime: resource?.["uptime"] as string | undefined,
          cpuLoad: resource?.["cpu-load"] as string | undefined,
          freeMemory: resource?.["free-memory"] as string | undefined,
          totalMemory: resource?.["total-memory"] as string | undefined,
          latencyMs,
        };

        return {
          content: `Router ${context.routerId} is healthy (${latencyMs}ms)`,
          structuredContent: result,
        };
      } catch (err) {
        const latencyMs = Date.now() - startMs;
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Router ${context.routerId} is unhealthy: ${message}`,
          structuredContent: {
            routerId: context.routerId,
            healthy: false,
            latencyMs,
            error: message,
          },
        };
      }
    },
  };

  const bulkExecuteTool: ToolDefinition = {
    name: "bulk_execute",
    title: "Bulk Execute",
    description:
      "Fan out a single-router tool to multiple routers in parallel (up to `concurrency` at a time). Target routers via explicit routerIds or by tag. Destructive tools are not allowed. Returns per-router results with succeeded/failed counts.",
    inputSchema: bulkExecuteInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    skipRouterContext: true,
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const parsed = bulkExecuteInputSchema.parse(params);

      // Treat empty arrays as not provided — MCP Inspector defaults optional arrays to []
      const hasRouterIds = Array.isArray(parsed.routerIds) && parsed.routerIds.length > 0;
      const hasTags = Array.isArray(parsed.tags) && parsed.tags.length > 0;

      if (hasRouterIds === hasTags) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "BULK_TARGET_REQUIRED",
          message: "Provide exactly one of routerIds or tags, not both and not neither.",
          recoverability: {
            retryable: false,
            suggestedAction: "Supply either routerIds (array of IDs) or tags (array of tag strings).",
          },
        });
      }

      log.info(
        { toolName: parsed.toolName, concurrency: parsed.concurrency },
        "bulk_execute invoked",
      );

      auditLog({
        type: "audit",
        ts: new Date().toISOString(),
        correlationId: context.correlationId,
        identityId: context.identity.id,
        role: context.identity.role,
        tool: "bulk_execute",
        routerId: "(fleet)",
        phase: "attempt",
        params: { toolName: parsed.toolName, routerIds: parsed.routerIds, tags: parsed.tags },
      }, context.appConfig.auditLogPath);

      if (parsed.toolName === "bulk_execute" || parsed.toolName === "check_router_health") {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "BULK_SELF_REFERENCE",
          message: `Cannot use bulk_execute to fan out fleet tools ("${parsed.toolName}").`,
          recoverability: {
            retryable: false,
            suggestedAction: "Choose a single-router tool as the toolName.",
          },
        });
      }

      const foundTool = toolMap.get(parsed.toolName);
      if (!foundTool) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "TOOL_NOT_FOUND",
          message: `Tool "${parsed.toolName}" not found. Available tools: ${[...toolMap.keys()].join(", ")}`,
          recoverability: {
            retryable: false,
            suggestedAction: "Check the tool name and try again.",
          },
        });
      }
      const targetTool: ToolDefinition = foundTool;

      if (targetTool.annotations.destructiveHint) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "BULK_DESTRUCTIVE_NOT_ALLOWED",
          message: `Tool "${parsed.toolName}" is destructive. Destructive tools require per-router confirmation and cannot be fanned out via bulk_execute.`,
          recoverability: {
            retryable: false,
            suggestedAction:
              "Call the tool directly on each router to provide the required confirmation token.",
          },
        });
      }

      // Pre-resolution errors (unknown IDs) become immediate error results
      const preErrors: BulkResult[] = [];
      let routers: RouterConfig[];
      if (hasRouterIds) {
        const resolved: RouterConfig[] = [];
        for (const id of parsed.routerIds!) {
          try {
            resolved.push(context.routerRegistry!.getRouter(id));
          } catch {
            log.warn({ routerId: id }, "bulk_execute: router not found");
            preErrors.push({ routerId: id, status: "error", error: `Router "${id}" not found in registry`, durationMs: 0 });
          }
        }
        routers = resolved;
      } else {
        routers = context.routerRegistry!.listRouters(parsed.tags!);
      }

      if (routers.length === 0 && preErrors.length === 0) {
        auditLog({
          type: "audit",
          ts: new Date().toISOString(),
          correlationId: context.correlationId,
          identityId: context.identity.id,
          role: context.identity.role,
          tool: "bulk_execute",
          routerId: "(fleet)",
          phase: "success",
          params: { toolName: parsed.toolName, succeeded: 0, failed: 0 },
        }, context.appConfig.auditLogPath);
        return {
          content: `Executed ${parsed.toolName} on 0 routers: 0 succeeded, 0 failed`,
          structuredContent: {
            toolName: parsed.toolName,
            totalRouters: 0,
            succeeded: 0,
            failed: 0,
            results: [],
          },
        };
      }

      async function runForRouter(router: RouterConfig): Promise<BulkResult> {
        const start = Date.now();
        try {
          checkAuthz(context.identity, parsed.toolName, router.id);
          const routerContext = buildRouterToolContext({
            routerConfig: router,
            correlationId: context.correlationId,
            identity: context.identity,
            pool: context.connectionPool!,
            config: context.appConfig,
            registry: context.routerRegistry,
          });
          const toolParams = { ...parsed.params, routerId: router.id };
          const result = await targetTool.handler(
            toolParams as Record<string, unknown>,
            routerContext,
          );
          const elapsed = Date.now() - start;
          auditLog({
            type: "audit",
            ts: new Date().toISOString(),
            correlationId: context.correlationId,
            identityId: context.identity.id,
            role: context.identity.role,
            tool: parsed.toolName,
            routerId: router.id,
            phase: "success",
            params: parsed.params as Record<string, unknown>,
            durationMs: elapsed,
          }, context.appConfig.auditLogPath);
          return { routerId: router.id, status: "ok", result, durationMs: elapsed };
        } catch (err) {
          const elapsed = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          auditLog({
            type: "audit",
            ts: new Date().toISOString(),
            correlationId: context.correlationId,
            identityId: context.identity.id,
            role: context.identity.role,
            tool: parsed.toolName,
            routerId: router.id,
            phase: "failure",
            params: parsed.params as Record<string, unknown>,
            outcome: message,
            durationMs: elapsed,
          }, context.appConfig.auditLogPath);
          return { routerId: router.id, status: "error", error: message, durationMs: elapsed };
        }
      }

      const results: BulkResult[] = [...preErrors];
      for (let i = 0; i < routers.length; i += parsed.concurrency) {
        const batch = routers.slice(i, i + parsed.concurrency);
        const batchResults = await Promise.all(batch.map(runForRouter));
        results.push(...batchResults);
      }

      const succeeded = results.filter((r) => r.status === "ok").length;
      const failed = results.filter((r) => r.status === "error").length;

      auditLog({
        type: "audit",
        ts: new Date().toISOString(),
        correlationId: context.correlationId,
        identityId: context.identity.id,
        role: context.identity.role,
        tool: "bulk_execute",
        routerId: "(fleet)",
        phase: "success",
        params: { toolName: parsed.toolName, succeeded, failed },
      }, context.appConfig.auditLogPath);

      return {
        content: `Executed ${parsed.toolName} on ${results.length} routers: ${succeeded} succeeded, ${failed} failed`,
        structuredContent: {
          toolName: parsed.toolName,
          totalRouters: results.length,
          succeeded,
          failed,
          results,
        },
      };
    },
  };

  return [checkRouterHealthTool, bulkExecuteTool];
}

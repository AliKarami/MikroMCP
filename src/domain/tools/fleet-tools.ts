import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { compactFields } from "./pagination.js";
import type { RouterOSRecord, RouterConfig } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { auditLog } from "../../observability/audit-log.js";
import { checkAuthz } from "../../middleware/authz.js";
import { buildRouterToolContext } from "../../mcp/tool-context.js";
import { checkFleetConfirmation } from "../../middleware/fleet-confirmation.js";
import { takeSnapshot } from "../snapshot/snapshot-engine.js";
import { recordAttempt, recordOutcome } from "../snapshot/write-journal.js";

const log = createLogger("fleet-tools");

const checkHealthInputSchema = z
  .object({
    routerId,
  })
  .strict();

const bulkExecuteInputSchema = z
  .object({
    toolName: z.string().describe("Name of the tool to fan out (must be a single-router tool)"),
    routerIds: z.array(z.string()).optional().describe("Explicit list of router IDs to target"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Target all routers with ALL of these tags (mutually exclusive with routerIds)"),
    params: z
      .record(z.string(), z.unknown())
      .describe("Params to pass to the tool (omit routerId — injected per router)"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Max simultaneous router calls"),
    confirmationToken: z
      .string()
      .optional()
      .describe(
        "Fleet confirmation token from a prior APPROVAL_REQUIRED response. Required to fan out a destructive tool.",
      ),
  })
  .strict();

interface BulkResult {
  routerId: string;
  status: "ok" | "error";
  result?: ToolResult;
  error?: string;
  durationMs: number;
}

const listRoutersInputSchema = z
  .object({
    tags: z
      .array(z.string())
      .optional()
      .describe('Only return routers having any of these tags (e.g. ["edge", "prod"])'),
  })
  .strict();

const listRoutersTool: ToolDefinition = {
  name: "list_routers",
  title: "List Routers",
  description:
    "List the routers configured in the registry (routers.yaml): id, host, port, TLS status, tags, ROS version, and which is the default. Read-only reflection of local config — no RouterOS API call, no credentials in the response. Use it to discover valid routerId values and tags for targeting other tools (including bulk_execute).",
  inputSchema: listRoutersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  skipRouterContext: true,
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listRoutersInputSchema.parse(params);
    const { identity, appConfig } = context;
    const defaultRouter = appConfig.defaultRouter;

    log.info({ tags: parsed.tags, identityId: identity.id }, "Listing routers");

    let routers = context.routerRegistry!.listRouters(parsed.tags);

    // Respect the identity's router scope (empty allowedRouters = all), mirroring checkAuthz,
    // so a scoped caller can't discover routers it isn't permitted to use.
    if (identity.allowedRouters.length > 0) {
      routers = routers.filter((r) => identity.allowedRouters.includes(r.id));
    }

    // A router is default when explicitly configured, or — when none is set — when it is the
    // only one. Mirrors the executor's routerId resolution.
    const soleDefaultId = defaultRouter === undefined && routers.length === 1 ? routers[0].id : undefined;
    const rows = routers.map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      tlsEnabled: r.tls.enabled,
      tags: r.tags,
      rosVersion: r.rosVersion,
      isDefault: defaultRouter !== undefined ? r.id === defaultRouter : r.id === soleDefaultId,
    }));

    const total = rows.length;
    const header = `Routers: ${total === 0 ? "none" : `1-${total} of ${total}`}.`;
    const lines = rows.map(
      (r) =>
        `  ${compactFields(
          { ...r, tags: r.tags.join(",") },
          ["id", "host", "port", "tlsEnabled", "tags", "rosVersion", "isDefault"],
        )}`,
    );

    return {
      content: total === 0 ? header : [header, ...lines].join("\n"),
      structuredContent: { routers: rows, total, returned: total },
    };
  },
};

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
      "Fan out a single-router tool to many routers in parallel (up to `concurrency`), targeted by routerIds or tag. Destructive tools need two-step confirmation: call without `confirmationToken` to get a fleet token (needs MIKROMCP_CONFIRMATION_SECRET), then re-call with it. Writes snapshot+journal each router for rollback. Returns per-router results with succeeded/failed counts.",
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
            preErrors.push({
              routerId: id,
              status: "error",
              error: `Router "${id}" not found in registry`,
              durationMs: 0,
            });
          }
        }
        routers = resolved;
      } else {
        routers = context.routerRegistry!.listRouters(parsed.tags!);
      }

      if (targetTool.annotations.destructiveHint) {
        const secret = context.appConfig.confirmationSecret;
        if (!secret) {
          throw new MikroMCPError({
            category: ErrorCategory.CONFIGURATION,
            code: "FLEET_CONFIRMATION_UNAVAILABLE",
            message:
              "Fanning out a destructive tool requires MIKROMCP_CONFIRMATION_SECRET to be configured.",
            recoverability: {
              retryable: false,
              suggestedAction: "Set MIKROMCP_CONFIRMATION_SECRET, or call the tool per-router.",
            },
          });
        }
        const routerIdList = routers.map((r) => r.id);
        checkFleetConfirmation(
          {
            toolName: parsed.toolName,
            routerIds: routerIdList,
            params: parsed.params as Record<string, unknown>,
            identityId: context.identity.id,
            submittedToken: parsed.confirmationToken,
          },
          secret,
        );
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

      const isWrite = !targetTool.annotations.readOnlyHint;
      const snapshotDir = context.appConfig.snapshotDir;
      const journalPath = context.appConfig.journalPath;

      async function runForRouter(router: RouterConfig): Promise<BulkResult> {
        const start = Date.now();
        let journalId: string | undefined;
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

          const snapshotIds: string[] = [];
          if (isWrite && targetTool.snapshotPaths && targetTool.snapshotPaths.length > 0) {
            for (const path of targetTool.snapshotPaths) {
              try {
                const meta = await takeSnapshot(
                  routerContext.routerClient,
                  router.id,
                  path,
                  snapshotDir,
                );
                snapshotIds.push(meta.id);
              } catch (err) {
                log.warn(
                  { err, path, routerId: router.id },
                  "bulk_execute snapshot failed — proceeding without snapshot",
                );
              }
            }
          }

          if (isWrite && journalPath) {
            journalId = recordAttempt({
              journalPath,
              identityId: context.identity.id,
              role: context.identity.role,
              tool: parsed.toolName,
              routerId: router.id,
              params: toolParams as Record<string, unknown>,
              snapshotIds,
            });
          }

          const result = await targetTool.handler(
            toolParams as Record<string, unknown>,
            routerContext,
          );
          const elapsed = Date.now() - start;
          if (journalId) {
            recordOutcome({ journalPath: journalPath!, journalId, phase: "success", durationMs: elapsed });
          }
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
          if (journalId) {
            recordOutcome({ journalPath: journalPath!, journalId, phase: "failure", outcome: message, durationMs: elapsed });
          }
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

  return [checkRouterHealthTool, bulkExecuteTool, listRoutersTool];
}

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { snapshotPathsFor } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { compactFields } from "./pagination.js";
import type { RouterOSRecord, RouterConfig } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { auditLog } from "../../observability/audit-log.js";
import { checkAuthz } from "../../middleware/authz.js";
import { buildRouterToolContext } from "../../mcp/tool-context.js";
import {
  getOrCreateBreaker,
  assertMaintenanceWindow,
  assertPlatformMatch,
} from "../../mcp/tool-executor.js";
import { withRetry } from "../../adapter/retry-engine.js";
import { checkFleetConfirmation } from "../../middleware/fleet-confirmation.js";
import { takeSnapshot } from "../snapshot/snapshot-engine.js";
import { recordAttempt, recordOutcome } from "../snapshot/write-journal.js";

const log = createLogger("fleet-tools");

/** Map a decoded SwOS `sys.b` blob onto the subset of system/resource fields health reports. */
function swosResourceRecord(sys: unknown): Record<string, string> {
  const decoded = (sys ?? {}) as Record<string, unknown>;
  return {
    version: String(decoded.version ?? ""),
    uptime: `${String(decoded.uptime ?? 0)}s`,
  };
}

const checkHealthInputSchema = z
  .object({
    routerId,
  })
  .strict();

const fanOutFields = {
  routerIds: z.array(z.string()).optional().describe("Explicit list of router IDs to target"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Target all routers with ALL of these tags (mutually exclusive with routerIds)"),
  params: z
    .record(z.string(), z.unknown())
    .describe("Params to pass to the tool (omit routerId — injected per router)"),
  concurrency: z.number().int().min(1).max(20).default(5).describe("Max simultaneous router calls"),
};

const bulkExecuteInputSchema = z
  .object({
    toolName: z.string().describe("Name of the tool to fan out (must be a single-router tool)"),
    ...fanOutFields,
    confirmationToken: z
      .string()
      .optional()
      .describe(
        "Fleet confirmation token from a prior APPROVAL_REQUIRED response. Required to fan out a destructive tool.",
      ),
  })
  .strict();

const bulkReadInputSchema = z
  .object({
    toolName: z
      .string()
      .describe("Name of the read-only single-router tool to fan out (e.g. list_interfaces)"),
    ...fanOutFields,
  })
  .strict();

type FanOutInput = z.infer<typeof bulkReadInputSchema>;
type FleetToolName = "bulk_execute" | "bulk_read";

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
    "List the routers configured in the registry (routers.yaml): id, host, port, TLS status, tags, ROS version, and which is the default. Read-only reflection of local config — no RouterOS API call, no credentials in the response. Use it to discover valid routerId values and tags for targeting other tools (including bulk_read and bulk_execute).",
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
    const soleDefaultId =
      defaultRouter === undefined && routers.length === 1 ? routers[0].id : undefined;
    const rows = routers.map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      deviceType: r.deviceType ?? "routeros",
      tlsEnabled: r.tls.enabled,
      tags: r.tags,
      rosVersion: r.rosVersion,
      isDefault: defaultRouter !== undefined ? r.id === defaultRouter : r.id === soleDefaultId,
    }));

    const total = rows.length;
    const header = `Routers: ${total === 0 ? "none" : `1-${total} of ${total}`}.`;
    const lines = rows.map(
      (r) =>
        `  ${compactFields({ ...r, tags: r.tags.join(",") }, [
          "id",
          "host",
          "port",
          "deviceType",
          "tlsEnabled",
          "tags",
          "rosVersion",
          "isDefault",
        ])}`,
    );

    return {
      content: total === 0 ? header : [header, ...lines].join("\n"),
      structuredContent: { routers: rows, total, returned: total },
    };
  },
};

/** Fleet tools are not in the base tool map; named here so fanning one out fails with a clear code. */
const FLEET_TOOL_NAMES = new Set(["bulk_execute", "bulk_read", "check_router_health"]);

/**
 * Annotated read-only, yet each call sends traffic from the router (ping, traceroute,
 * bandwidth_test) or loads it for the sampling window (torch). A fleet-wide run of these
 * stays an explicit bulk_execute call, so allowing bulk_read never allows them.
 */
const BULK_READ_EXCLUDED_TOOLS = new Set(["ping", "traceroute", "torch", "bandwidth_test"]);

// Treat empty arrays as not provided — MCP Inspector defaults optional arrays to []
function hasItems(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

function assertSingleTarget(input: FanOutInput): void {
  if (hasItems(input.routerIds) === hasItems(input.tags)) {
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
}

function resolveInnerTool(
  fleetTool: FleetToolName,
  toolName: string,
  toolMap: Map<string, ToolDefinition>,
): ToolDefinition {
  if (FLEET_TOOL_NAMES.has(toolName)) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "BULK_SELF_REFERENCE",
      message: `Cannot use ${fleetTool} to fan out fleet tools ("${toolName}").`,
      recoverability: {
        retryable: false,
        suggestedAction: "Choose a single-router tool as the toolName.",
      },
    });
  }
  const tool = toolMap.get(toolName);
  if (!tool) {
    throw new MikroMCPError({
      category: ErrorCategory.NOT_FOUND,
      code: "TOOL_NOT_FOUND",
      message: `Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(", ")}`,
      recoverability: {
        retryable: false,
        suggestedAction: "Check the tool name and try again.",
      },
    });
  }
  return tool;
}

function assertBulkReadable(tool: ToolDefinition): void {
  const readOnly = tool.annotations.readOnlyHint === true;
  if (readOnly && !BULK_READ_EXCLUDED_TOOLS.has(tool.name)) return;
  throw new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "BULK_READ_TOOL_NOT_READ_ONLY",
    message: readOnly
      ? `bulk_read does not fan out "${tool.name}": it generates traffic or load on every targeted router.`
      : `bulk_read only fans out read-only tools; "${tool.name}" can change router state.`,
    details: { toolName: tool.name },
    recoverability: {
      retryable: false,
      suggestedAction: `Use bulk_execute to fan out "${tool.name}".`,
      alternativeTools: ["bulk_execute"],
    },
  });
}

/** Unknown router IDs become per-router error results instead of failing the whole call. */
function resolveRouters(
  fleetTool: FleetToolName,
  input: FanOutInput,
  context: ToolContext,
): { routers: RouterConfig[]; preErrors: BulkResult[] } {
  const preErrors: BulkResult[] = [];
  if (hasItems(input.routerIds)) {
    const routers: RouterConfig[] = [];
    for (const id of input.routerIds) {
      try {
        routers.push(context.routerRegistry!.getRouter(id));
      } catch {
        log.warn({ routerId: id }, `${fleetTool}: router not found`);
        preErrors.push({
          routerId: id,
          status: "error",
          error: `Router "${id}" not found in registry`,
          durationMs: 0,
        });
      }
    }
    return { routers, preErrors };
  }
  // ALL-tag targeting (schema documents "ALL of these tags"): a router must
  // carry every requested tag. listRouters() matches ANY tag, so filter here.
  const tags = input.tags ?? [];
  const routers = context
    .routerRegistry!.listRouters()
    .filter((r) => tags.every((t) => r.tags.includes(t)));
  return { routers, preErrors };
}

function fleetAudit(
  context: ToolContext,
  fleetTool: FleetToolName,
  phase: "attempt" | "success",
  params: Record<string, unknown>,
): void {
  auditLog(
    {
      type: "audit",
      ts: new Date().toISOString(),
      correlationId: context.correlationId,
      identityId: context.identity.id,
      role: context.identity.role,
      tool: fleetTool,
      routerId: "(fleet)",
      phase,
      params,
    },
    context.appConfig.auditLogPath,
  );
}

interface FanOutRequest {
  fleetTool: FleetToolName;
  input: FanOutInput;
  targetTool: ToolDefinition;
  routers: RouterConfig[];
  preErrors: BulkResult[];
  context: ToolContext;
  /** Audit the fan-out and each router call. Off for bulk_read, matching direct read-only calls. */
  audit: boolean;
}

/**
 * Run the inner tool on every router through the same per-router safety stack as a direct
 * call: authz, platform check, maintenance window, circuit breaker, and retry for read tools.
 * Write tools additionally get a snapshot and a journal entry per router.
 */
async function fanOut(req: FanOutRequest): Promise<ToolResult> {
  const { fleetTool, input, targetTool, context } = req;
  const isWrite = !targetTool.annotations.readOnlyHint;
  const snapshotDir = context.appConfig.snapshotDir;
  const journalPath = context.appConfig.journalPath;

  async function runForRouter(router: RouterConfig): Promise<BulkResult> {
    const start = Date.now();
    let journalId: string | undefined;
    try {
      checkAuthz(context.identity, input.toolName, router.id);
      // Authz first, so an unauthorized caller cannot learn a router's
      // device type from the platform error.
      assertPlatformMatch(targetTool, router);
      assertMaintenanceWindow(targetTool.annotations.destructiveHint, router, router.id);
      const routerContext = buildRouterToolContext({
        routerConfig: router,
        correlationId: context.correlationId,
        identity: context.identity,
        pool: context.connectionPool!,
        config: context.appConfig,
        registry: context.routerRegistry,
      });
      const toolParams = { ...input.params, routerId: router.id };

      const snapshotIds: string[] = [];
      if (isWrite) {
        for (const path of snapshotPathsFor(targetTool, toolParams as Record<string, unknown>)) {
          try {
            const meta = await takeSnapshot(
              routerContext.deviceClient,
              router.id,
              path,
              snapshotDir,
            );
            snapshotIds.push(meta.id);
          } catch (err) {
            log.warn(
              { err, path, routerId: router.id },
              `${fleetTool} snapshot failed — proceeding without snapshot`,
            );
          }
        }
      }

      if (isWrite && journalPath) {
        journalId = recordAttempt({
          journalPath,
          identityId: context.identity.id,
          role: context.identity.role,
          tool: input.toolName,
          routerId: router.id,
          params: toolParams as Record<string, unknown>,
          snapshotIds,
        });
      }

      const cb = getOrCreateBreaker(context.circuitBreakers!, router.id, context.appConfig);
      routerContext.circuitBreaker = cb;
      const runOnce = () =>
        targetTool.handler(toolParams as Record<string, unknown>, routerContext);
      const shouldRetry = targetTool.annotations.readOnlyHint && targetTool.retryable !== false;
      const result = await cb.execute(
        shouldRetry ? () => withRetry(runOnce, context.appConfig.retry) : runOnce,
      );
      const elapsed = Date.now() - start;
      if (journalId) {
        recordOutcome({
          journalPath: journalPath!,
          journalId,
          phase: "success",
          durationMs: elapsed,
        });
      }
      if (req.audit) {
        auditLog(
          {
            type: "audit",
            ts: new Date().toISOString(),
            correlationId: context.correlationId,
            identityId: context.identity.id,
            role: context.identity.role,
            tool: input.toolName,
            routerId: router.id,
            phase: "success",
            params: input.params as Record<string, unknown>,
            durationMs: elapsed,
          },
          context.appConfig.auditLogPath,
        );
      }
      return { routerId: router.id, status: "ok", result, durationMs: elapsed };
    } catch (err) {
      const elapsed = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      if (journalId) {
        recordOutcome({
          journalPath: journalPath!,
          journalId,
          phase: "failure",
          outcome: message,
          durationMs: elapsed,
        });
      }
      if (req.audit) {
        auditLog(
          {
            type: "audit",
            ts: new Date().toISOString(),
            correlationId: context.correlationId,
            identityId: context.identity.id,
            role: context.identity.role,
            tool: input.toolName,
            routerId: router.id,
            phase: "failure",
            params: input.params as Record<string, unknown>,
            outcome: message,
            durationMs: elapsed,
          },
          context.appConfig.auditLogPath,
        );
      }
      return { routerId: router.id, status: "error", error: message, durationMs: elapsed };
    }
  }

  const results: BulkResult[] = [...req.preErrors];
  for (let i = 0; i < req.routers.length; i += input.concurrency) {
    const batch = req.routers.slice(i, i + input.concurrency);
    results.push(...(await Promise.all(batch.map(runForRouter))));
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  if (req.audit) {
    fleetAudit(context, fleetTool, "success", { toolName: input.toolName, succeeded, failed });
  }

  return {
    content: `Executed ${input.toolName} on ${results.length} routers: ${succeeded} succeeded, ${failed} failed`,
    structuredContent: {
      toolName: input.toolName,
      totalRouters: results.length,
      succeeded,
      failed,
      results,
    },
  };
}

export function createFleetTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const toolMap = new Map(baseTools.map((t) => [t.name, t]));

  const checkRouterHealthTool: ToolDefinition = {
    name: "check_router_health",
    title: "Check Router Health",
    description:
      "Probe a device: RouterOS routers via system/resource, SwOS switches via sys.b. Returns health status, firmware version, uptime, and (RouterOS only) CPU load and memory info. Unlike other tools, this never throws — unreachable devices are reported as healthy=false.",
    inputSchema: checkHealthInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    platform: "any",
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      checkHealthInputSchema.parse(params);
      log.info({ routerId: context.routerId }, "Checking router health");
      const startMs = Date.now();

      try {
        const resource = context.swosClient
          ? swosResourceRecord(await context.swosClient.get("sys.b"))
          : (await context.routerClient.get<RouterOSRecord>("system/resource"))[0];
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
      "Fan out a single-router tool to many routers in parallel (up to `concurrency`), targeted by routerIds or tag. Destructive tools need two-step confirmation: call without `confirmationToken` to get a fleet token (needs MIKROMCP_CONFIRMATION_SECRET), then re-call with it. Writes snapshot+journal each router for rollback. Returns per-router results with succeeded/failed counts. To fan out a read-only tool, prefer bulk_read.",
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
      assertSingleTarget(parsed);

      log.info(
        { toolName: parsed.toolName, concurrency: parsed.concurrency },
        "bulk_execute invoked",
      );

      fleetAudit(context, "bulk_execute", "attempt", {
        toolName: parsed.toolName,
        routerIds: parsed.routerIds,
        tags: parsed.tags,
      });

      const targetTool = resolveInnerTool("bulk_execute", parsed.toolName, toolMap);
      const { routers, preErrors } = resolveRouters("bulk_execute", parsed, context);

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
        checkFleetConfirmation(
          {
            toolName: parsed.toolName,
            routerIds: routers.map((r) => r.id),
            params: parsed.params as Record<string, unknown>,
            identityId: context.identity.id,
            submittedToken: parsed.confirmationToken,
          },
          secret,
        );
      }

      return fanOut({
        fleetTool: "bulk_execute",
        input: parsed,
        targetTool,
        routers,
        preErrors,
        context,
        audit: true,
      });
    },
  };

  const bulkReadTool: ToolDefinition = {
    name: "bulk_read",
    title: "Bulk Read",
    description:
      "Fan out a read-only single-router tool (list_*, get_* and others annotated read-only) to many routers in parallel (up to `concurrency`), targeted by routerIds or tag. Unlike bulk_execute, the server refuses every write tool and the traffic-generating diagnostics (ping, traceroute, torch, bandwidth_test) with BULK_READ_TOOL_NOT_READ_ONLY, and never needs a confirmation token, snapshot or journal — so an MCP client can allow bulk_read without allowing fleet-wide writes. Use bulk_execute for anything else. Returns per-router results with succeeded/failed counts.",
    inputSchema: bulkReadInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    skipRouterContext: true,
    async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const parsed = bulkReadInputSchema.parse(params);
      assertSingleTarget(parsed);

      log.info({ toolName: parsed.toolName, concurrency: parsed.concurrency }, "bulk_read invoked");

      const targetTool = resolveInnerTool("bulk_read", parsed.toolName, toolMap);
      assertBulkReadable(targetTool);
      const { routers, preErrors } = resolveRouters("bulk_read", parsed, context);

      return fanOut({
        fleetTool: "bulk_read",
        input: parsed,
        targetTool,
        routers,
        preErrors,
        context,
        audit: false,
      });
    },
  };

  return [checkRouterHealthTool, bulkExecuteTool, bulkReadTool, listRoutersTool];
}

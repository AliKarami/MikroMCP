import { nanoid } from "nanoid";
import { withContext } from "../observability/correlation.js";
import { getCurrentIdentity, getStdioIdentity } from "../middleware/auth.js";
import { checkAuthz } from "../middleware/authz.js";
import { checkConfirmation } from "../middleware/confirmation.js";
import { auditLog } from "../observability/audit-log.js";
import { takeSnapshot } from "../domain/snapshot/snapshot-engine.js";
import { recordAttempt, recordOutcome } from "../domain/snapshot/write-journal.js";
import { withRetry } from "../adapter/retry-engine.js";
import { isWithinMaintenanceWindow } from "../config/maintenance-window.js";
import { buildRouterToolContext } from "./tool-context.js";
import { formatToolResult, formatError } from "./response-formatter.js";
import type { McpToolResponse } from "./response-formatter.js";
import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";
import { enrichError } from "../domain/errors/error-enricher.js";
import { createLogger } from "../observability/logger.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import type { ToolContext, ToolDefinition } from "../domain/tools/tool-definition.js";
import type { RouterRegistry } from "../config/router-registry.js";
import type { ConnectionPool } from "../adapter/connection-pool.js";
import type { AppConfig } from "../config/app-config.js";
import type { IdentityRegistry } from "../config/identity-registry.js";

const log = createLogger("tool-executor");

export interface ToolExecutorDeps {
  registry: RouterRegistry;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
  config: AppConfig;
  identityRegistry: IdentityRegistry;
}

export async function executeToolCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  deps: ToolExecutorDeps,
): Promise<McpToolResponse> {
  const { registry, pool, circuitBreakers, config, identityRegistry } = deps;
  const correlationId = nanoid();

  return withContext({ correlationId, tool: tool.name }, async () => {
    const startMs = Date.now();
    let journalId: string | undefined;

    try {
      const identity = getCurrentIdentity() ?? getStdioIdentity(config.stdioIdentity, identityRegistry);

      if (tool.skipRouterContext) {
        const fleetContext: ToolContext = {
          routerClient: null as unknown as ToolContext["routerClient"],
          routerId: "",
          correlationId,
          routerConfig: null as unknown as ToolContext["routerConfig"],
          sshClient: null as unknown as ToolContext["sshClient"],
          ftpClient: null as unknown as ToolContext["ftpClient"],
          identity,
          routerRegistry: registry,
          connectionPool: pool,
          appConfig: config,
        };
        return formatToolResult(await tool.handler(args, fleetContext));
      }

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

      checkAuthz(identity, tool.name, routerId);

      const routerConfig = registry.getRouter(routerId);

      if (tool.annotations.destructiveHint) {
        const windows = routerConfig.maintenanceWindows;
        if (windows && windows.length > 0 && !isWithinMaintenanceWindow(windows, new Date())) {
          throw new MikroMCPError({
            category: ErrorCategory.PERMISSION_DENIED,
            code: "OUTSIDE_MAINTENANCE_WINDOW",
            message: `Router "${routerId}" has maintenance windows configured. Destructive operations are only permitted during scheduled windows.`,
            details: { maintenanceWindows: windows },
            recoverability: {
              retryable: true,
              suggestedAction: "Wait for a scheduled maintenance window, or remove maintenanceWindows from routers.yaml to allow unrestricted access.",
            },
          });
        }
      }

      if (tool.annotations.destructiveHint && config.confirmationSecret) {
        await checkConfirmation(tool.name, routerId, args, identity, config.confirmationSecret);
      }

      const shouldAudit = tool.annotations.destructiveHint || !tool.annotations.readOnlyHint;
      if (shouldAudit) {
        auditLog({
          type: "audit",
          ts: new Date().toISOString(),
          correlationId,
          identityId: identity.id,
          role: identity.role,
          tool: tool.name,
          routerId,
          phase: "attempt",
          params: args,
        }, config.auditLogPath);
      }

      const toolContext = buildRouterToolContext({
        routerConfig,
        correlationId,
        identity,
        pool,
        config,
        registry,
      });

      let cb = circuitBreakers.get(routerId);
      if (!cb) {
        cb = new CircuitBreaker(routerId, {
          failureThreshold: config.circuitBreaker.failureThreshold,
          cooldownMs: config.circuitBreaker.cooldownMs,
        });
        circuitBreakers.set(routerId, cb);
      }

      toolContext.circuitBreaker = cb;

      const { confirmationToken: _ct, ...handlerArgs } = args;

      const snapshotIds: string[] = [];
      if (tool.snapshotPaths && tool.snapshotPaths.length > 0 && !tool.annotations.readOnlyHint) {
        for (const path of tool.snapshotPaths) {
          try {
            const meta = await takeSnapshot(toolContext.routerClient, routerId, path, config.snapshotDir);
            snapshotIds.push(meta.id);
            log.debug({ snapshotId: meta.id, path }, "Snapshot taken");
          } catch (err) {
            log.warn({ err, path, routerId }, "Snapshot failed — proceeding without snapshot");
          }
        }
      }

      if (!tool.annotations.readOnlyHint && config.journalPath) {
        journalId = recordAttempt({
          journalPath: config.journalPath,
          identityId: identity.id,
          role: identity.role,
          tool: tool.name,
          routerId,
          params: handlerArgs,
          snapshotIds,
        });
      }

      const runHandler = () => tool.handler(handlerArgs, toolContext);

      const executeHandler = () =>
        cb!.execute(
          tool.annotations.readOnlyHint
            ? () => withRetry(runHandler, config.retry)
            : runHandler,
        );

      const result = await executeHandler();

      if (journalId) {
        recordOutcome({
          journalPath: config.journalPath!,
          journalId,
          phase: "success",
          durationMs: Date.now() - startMs,
        });
      }

      if (shouldAudit) {
        auditLog({
          type: "audit",
          ts: new Date().toISOString(),
          correlationId,
          identityId: identity.id,
          role: identity.role,
          tool: tool.name,
          routerId,
          phase: "success",
          params: args,
          durationMs: Date.now() - startMs,
        }, config.auditLogPath);
      }

      log.info({ tool: tool.name, routerId, correlationId }, "Tool executed successfully");
      return formatToolResult(result);
    } catch (err) {
      const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: tool.name });

      if (error.category === ErrorCategory.ROUTER_AUTH_FAILED) {
        const failedRouterId = args.routerId as string | undefined;
        if (failedRouterId) {
          pool.removeClient(failedRouterId);
          log.info({ routerId: failedRouterId }, "Evicted pooled client after auth failure");
        }
      }

      if (journalId) {
        recordOutcome({
          journalPath: config.journalPath!,
          journalId,
          phase: "failure",
          outcome: error.code,
          durationMs: Date.now() - startMs,
        });
      }

      const shouldAudit = tool.annotations.destructiveHint || !tool.annotations.readOnlyHint;
      if (shouldAudit && error.category !== ErrorCategory.APPROVAL_REQUIRED) {
        const routerId = (args.routerId as string | undefined) ?? "unknown";
        const identity = getCurrentIdentity() ?? getStdioIdentity(config.stdioIdentity, identityRegistry);
        auditLog({
          type: "audit",
          ts: new Date().toISOString(),
          correlationId,
          identityId: identity.id,
          role: identity.role,
          tool: tool.name,
          routerId,
          phase: "failure",
          params: args,
          outcome: error.code,
          durationMs: Date.now() - startMs,
        }, config.auditLogPath);
      }

      log.error({ err: error, tool: tool.name, correlationId }, "Tool execution failed");
      return formatError(error);
    }
  });
}

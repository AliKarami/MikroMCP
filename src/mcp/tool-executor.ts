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
import { recordToolCall } from "../observability/metrics.js";
import { CircuitBreaker } from "../adapter/circuit-breaker.js";
import type { ToolContext, ToolDefinition } from "../domain/tools/tool-definition.js";
import type { RouterRegistry } from "../config/router-registry.js";
import type { RouterConfig } from "../types.js";
import type { ConnectionPool } from "../adapter/connection-pool.js";
import type { AppConfig } from "../config/app-config.js";
import type { IdentityRegistry } from "../config/identity-registry.js";

const log = createLogger("tool-executor");

/** Error categories where a write's outcome on the router is ambiguous (it may have applied). */
const AMBIGUOUS_WRITE_CATEGORIES = new Set<ErrorCategory>([
  ErrorCategory.ROUTER_TIMEOUT,
  ErrorCategory.ROUTER_UNREACHABLE,
]);

const VERIFY_STATE_PREFIX =
  "The write may already have been applied — verify router state before retrying. ";

/**
 * Resolve the target router id for a tool call. Precedence:
 *   1. Explicit `routerId` argument (must be a known router).
 *   2. `MIKROMCP_DEFAULT_ROUTER` config (must be a known router).
 *   3. The sole configured router when exactly one exists.
 * Throws a VALIDATION error listing available routers when none applies.
 */
function resolveRouterId(
  explicit: string | undefined,
  registry: RouterRegistry,
  config: AppConfig,
): string {
  if (explicit) {
    return explicit;
  }

  const fallback = config.defaultRouter ?? registry.soleRouterId();
  if (fallback) {
    return fallback;
  }

  const available = registry.routerIds();
  throw new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "MISSING_ROUTER_ID",
    message:
      available.length > 0
        ? `routerId is required: more than one router is configured. Available: ${available.join(", ")}.`
        : "routerId is required, but no routers are configured.",
    details: { availableRouters: available },
    recoverability: {
      retryable: false,
      suggestedAction:
        available.length > 0
          ? "Provide a routerId, or set MIKROMCP_DEFAULT_ROUTER to choose a default."
          : "Configure at least one router in routers.yaml.",
    },
  });
}

export interface ToolExecutorDeps {
  registry: RouterRegistry;
  pool: ConnectionPool;
  circuitBreakers: Map<string, CircuitBreaker>;
  config: AppConfig;
  identityRegistry: IdentityRegistry;
}

/** Get the per-router circuit breaker, creating and registering it on first use. */
export function getOrCreateBreaker(
  circuitBreakers: Map<string, CircuitBreaker>,
  routerId: string,
  config: AppConfig,
): CircuitBreaker {
  let cb = circuitBreakers.get(routerId);
  if (!cb) {
    cb = new CircuitBreaker(routerId, {
      failureThreshold: config.circuitBreaker.failureThreshold,
      cooldownMs: config.circuitBreaker.cooldownMs,
    });
    circuitBreakers.set(routerId, cb);
  }
  return cb;
}

/**
 * Throw OUTSIDE_MAINTENANCE_WINDOW when a destructive tool is invoked outside a
 * router's configured maintenance windows. No-op for non-destructive tools or
 * routers without windows.
 */
export function assertMaintenanceWindow(
  isDestructive: boolean,
  routerConfig: RouterConfig,
  routerId: string,
): void {
  if (!isDestructive) return;
  const windows = routerConfig.maintenanceWindows;
  if (windows && windows.length > 0 && !isWithinMaintenanceWindow(windows, new Date())) {
    throw new MikroMCPError({
      category: ErrorCategory.PERMISSION_DENIED,
      code: "OUTSIDE_MAINTENANCE_WINDOW",
      message: `Router "${routerId}" has maintenance windows configured. Destructive operations are only permitted during scheduled windows.`,
      details: { maintenanceWindows: windows },
      recoverability: {
        retryable: true,
        suggestedAction:
          "Wait for a scheduled maintenance window, or remove maintenanceWindows from routers.yaml to allow unrestricted access.",
      },
    });
  }
}

/**
 * Placeholder for router-scoped capabilities that a fleet tool
 * (`skipRouterContext`) does not have. Accessing any member throws a clear
 * typed error instead of the `TypeError` a `null` cast would produce.
 */
function fleetUnavailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new MikroMCPError({
        category: ErrorCategory.INTERNAL,
        code: "FLEET_CONTEXT_UNAVAILABLE",
        message: `${what} is not available in a fleet-tool context (skipRouterContext). Target a specific router instead.`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use a router-scoped tool, or pass a routerId to operate on one router.",
        },
      });
    },
  });
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
          routerClient: fleetUnavailable<ToolContext["routerClient"]>("routerClient"),
          routerId: "",
          correlationId,
          routerConfig: fleetUnavailable<ToolContext["routerConfig"]>("routerConfig"),
          sshClient: fleetUnavailable<ToolContext["sshClient"]>("sshClient"),
          ftpClient: fleetUnavailable<ToolContext["ftpClient"]>("ftpClient"),
          sftpClient: fleetUnavailable<ToolContext["sftpClient"]>("sftpClient"),
          identity,
          routerRegistry: registry,
          connectionPool: pool,
          circuitBreakers,
          appConfig: config,
        };
        const fleetResult = await tool.handler(args, fleetContext);
        recordToolCall(tool.name, "success");
        return formatToolResult(fleetResult);
      }

      const routerId = resolveRouterId(args.routerId as string | undefined, registry, config);
      args.routerId = routerId;

      checkAuthz(identity, tool.name, routerId);

      const routerConfig = registry.getRouter(routerId);

      assertMaintenanceWindow(tool.annotations.destructiveHint, routerConfig, routerId);

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

      const cb = getOrCreateBreaker(circuitBreakers, routerId, config);
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

      const shouldRetry = tool.annotations.readOnlyHint && tool.retryable !== false;
      const executeHandler = () =>
        cb.execute(shouldRetry ? () => withRetry(runHandler, config.retry) : runHandler);

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
      recordToolCall(tool.name, "success");
      return formatToolResult(result);
    } catch (err) {
      const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: tool.name });

      // A write that timed out or lost the connection may already have been
      // applied on the router — retrying blindly can double-apply. Tell the
      // caller to verify state first.
      if (
        !tool.annotations.readOnlyHint &&
        AMBIGUOUS_WRITE_CATEGORIES.has(error.category) &&
        !error.recoverability.suggestedAction.startsWith(VERIFY_STATE_PREFIX)
      ) {
        error.recoverability.suggestedAction = `${VERIFY_STATE_PREFIX}${error.recoverability.suggestedAction}`;
      }

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
      recordToolCall(tool.name, "error");
      return formatError(error);
    }
  });
}

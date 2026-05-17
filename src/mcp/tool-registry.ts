import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import type { IdentityRegistry } from "../config/identity-registry.js";
import { getCurrentIdentity, getStdioIdentity } from "../middleware/auth.js";
import { checkAuthz } from "../middleware/authz.js";
import { checkConfirmation } from "../middleware/confirmation.js";
import { auditLog } from "../observability/audit-log.js";
import { createSshClient, createFtpClient } from "../adapter/adapter-factory.js";
import { takeSnapshot } from "../domain/snapshot/snapshot-engine.js";
import { recordAttempt, recordOutcome } from "../domain/snapshot/write-journal.js";

const log = createLogger("tool-registry");

export function registerAllTools(
  server: McpServer,
  registry: RouterRegistry,
  pool: ConnectionPool,
  circuitBreakers: Map<string, CircuitBreaker>,
  config: AppConfig,
  identityRegistry: IdentityRegistry,
): void {
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
      async (args: Record<string, unknown>) => {
        const correlationId = nanoid();

        return withContext({ correlationId, tool: tool.name }, async () => {
          const startMs = Date.now();
          let journalId: string | undefined;

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

            const identity = getCurrentIdentity() ?? getStdioIdentity(config.stdioIdentity, identityRegistry);

            checkAuthz(identity, tool.name, routerId);

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
              });
            }

            const routerConfig = registry.getRouter(routerId);
            const credentials = getCredentials(routerConfig);
            const client = pool.getClient(routerConfig, credentials);
            const sshClient = createSshClient(routerConfig, config.ssh);
            const ftpClient = createFtpClient(routerConfig);

            let cb = circuitBreakers.get(routerId);
            if (!cb) {
              cb = new CircuitBreaker(routerId, {
                failureThreshold: config.circuitBreaker.failureThreshold,
                cooldownMs: config.circuitBreaker.cooldownMs,
              });
              circuitBreakers.set(routerId, cb);
            }

            const { confirmationToken: _ct, ...handlerArgs } = args;

            const snapshotIds: string[] = [];
            if (tool.snapshotPaths && tool.snapshotPaths.length > 0 && !tool.annotations.readOnlyHint) {
              for (const path of tool.snapshotPaths) {
                try {
                  const meta = await takeSnapshot(client, routerId, path, config.snapshotDir);
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

            const runHandler = () =>
              tool.handler(handlerArgs, {
                routerClient: client,
                routerId,
                correlationId,
                routerConfig,
                sshClient,
                ftpClient,
                identity,
              });

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
              });
            }

            log.info({ tool: tool.name, routerId, correlationId }, "Tool executed successfully");
            return formatToolResult(result);
          } catch (err) {
            const error = err instanceof MikroMCPError ? err : enrichError(err, { tool: tool.name });

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
              });
            }

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

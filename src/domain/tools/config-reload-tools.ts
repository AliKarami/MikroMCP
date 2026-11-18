import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { auditLog } from "../../observability/audit-log.js";
import { reloadConfig, type ReloadResult } from "../../config/reload.js";

const reloadConfigInputSchema = z
  .object({
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Check both files and report what would change, without changing the running server",
      ),
  })
  .strict();

function describeChanges(result: ReloadResult): string {
  const { routers, identities } = result;
  const lines = [
    `Routers: ${routers.added.length} added, ${routers.removed.length} removed, ${routers.changed.length} changed, ${routers.unchanged.length} unchanged.`,
    ...(routers.added.length > 0 ? [`  added: ${routers.added.join(", ")}`] : []),
    ...(routers.removed.length > 0 ? [`  removed: ${routers.removed.join(", ")}`] : []),
    ...routers.changed.map((c) => `  changed: ${c.id} (${c.fields.join(", ")})`),
    `Identities: ${identities.added.length} added, ${identities.removed.length} removed, ${identities.changed.length} changed, ${identities.unchanged.length} unchanged.`,
    ...(identities.added.length > 0 ? [`  added: ${identities.added.join(", ")}`] : []),
    ...(identities.removed.length > 0 ? [`  removed: ${identities.removed.join(", ")}`] : []),
    ...(identities.changed.length > 0 ? [`  changed: ${identities.changed.join(", ")}`] : []),
  ];
  return lines.join("\n");
}

const reloadConfigTool: ToolDefinition = {
  name: "reload_config",
  title: "Reload Configuration",
  description:
    "Re-read routers.yaml and identities.yaml without restarting the server (the same as sending it SIGHUP) and report which routers and identities were added, removed or changed, by id and field name. Both files are checked first: if either is missing or invalid, nothing changes and the error names the problem. Pooled connections and circuit breakers of changed or removed routers are dropped, so the next call connects with the new settings. Cached identity tokens are cleared, so a revoked token stops working. In HTTP mode a file with readonly or operator identities is refused unless MIKROMCP_CONFIRMATION_SECRET is set. Needs an admin or superadmin identity. With dryRun it reports what would change and changes nothing. Server settings (MIKROMCP_* environment variables, the HTTP port) are not reloaded.",
  inputSchema: reloadConfigInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  skipRouterContext: true,
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = reloadConfigInputSchema.parse(params);
    const { identity } = context;
    if (identity.role !== "admin" && identity.role !== "superadmin") {
      throw new MikroMCPError({
        category: ErrorCategory.PERMISSION_DENIED,
        code: "RELOAD_NOT_ALLOWED",
        message: `Identity "${identity.id}" has role ${identity.role}; reload_config needs admin or superadmin.`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use an admin identity, or send the server SIGHUP.",
        },
      });
    }
    if (!context.routerRegistry || !context.identityRegistry || !context.connectionPool) {
      throw new MikroMCPError({
        category: ErrorCategory.INTERNAL,
        code: "RELOAD_UNAVAILABLE",
        message: "The server did not provide its registries to this tool.",
        recoverability: {
          retryable: false,
          suggestedAction: "Report this: the server is wired without its registries.",
        },
      });
    }

    const audit = (phase: "success" | "failure", outcome: string) =>
      auditLog(
        {
          type: "audit",
          ts: new Date().toISOString(),
          correlationId: context.correlationId,
          identityId: identity.id,
          role: identity.role,
          tool: "reload_config",
          routerId: "",
          phase,
          params: { dryRun: parsed.dryRun },
          outcome,
        },
        context.appConfig.auditLogPath,
      );

    let result: ReloadResult;
    try {
      result = reloadConfig(
        {
          routerRegistry: context.routerRegistry,
          identityRegistry: context.identityRegistry,
          pool: context.connectionPool,
          circuitBreakers: context.circuitBreakers ?? new Map(),
          config: context.appConfig,
        },
        parsed.dryRun,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit("failure", message);
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "RELOAD_REFUSED",
        message: `Configuration not reloaded; the running configuration is unchanged. ${message}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Fix the file named in the message, then call reload_config again.",
        },
      });
    }
    audit("success", parsed.dryRun ? "dry_run" : "reloaded");

    return {
      content:
        (parsed.dryRun
          ? "Dry run: the files are valid and nothing was changed. A reload would do this:\n"
          : "Configuration reloaded:\n") + describeChanges(result),
      structuredContent: { ...result },
    };
  },
};

export const configReloadTools: ToolDefinition[] = [reloadConfigTool];

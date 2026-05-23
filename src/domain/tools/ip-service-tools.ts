import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ip-service-tools");

const SERVICE_NAMES = ["api", "api-ssl", "ssh", "telnet", "www", "www-ssl", "winbox", "ftp"] as const;

const listIpServicesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z
      .enum(SERVICE_NAMES)
      .optional()
      .describe("Filter by service name (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp)"),
    enabled: z
      .boolean()
      .optional()
      .describe("When true, return only enabled services; when false, only disabled services"),
  })
  .strict();

const listIpServicesTool: ToolDefinition = {
  name: "list_ip_services",
  title: "List IP Services",
  description:
    "List IP services on a MikroTik router (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp) with their port numbers and enabled/disabled status.",
  inputSchema: listIpServicesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpServicesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing IP services");
    try {
      const allServices = await context.routerClient.get<RouterOSRecord>("ip/service", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allServices as Record<string, unknown>[];

      if (parsed.name) {
        filtered = filtered.filter((s) => s.name === parsed.name);
      }

      if (parsed.enabled !== undefined) {
        filtered = filtered.filter((s) => {
          const isDisabled = s.disabled === true || s.disabled === "true";
          return parsed.enabled ? !isDisabled : isDisabled;
        });
      }

      const lines: string[] = [`IP services on ${context.routerId}: ${filtered.length} returned`];
      for (const s of filtered) {
        const rec = s as Record<string, unknown>;
        const isDisabled = rec.disabled === true || rec.disabled === "true";
        lines.push(`  ${rec.name}  port:${rec.port ?? "-"}  [${isDisabled ? "DISABLED" : "enabled"}]`);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          services: filtered,
          total: filtered.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_ip_services" });
    }
  },
};

const manageIpServiceInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z
      .enum(["enable", "disable"])
      .describe(
        "Action to perform — only enable/disable to prevent accidental lockout from changing ports",
      ),
    name: z
      .enum(SERVICE_NAMES)
      .describe("Service name to manage (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageIpServiceTool: ToolDefinition = {
  name: "manage_ip_service",
  title: "Manage IP Service",
  description:
    "Enable or disable a RouterOS IP service (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp). Port number changes are intentionally not supported to prevent accidental lockout.",
  inputSchema: manageIpServiceInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageIpServiceInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing IP service");

    try {
      const allServices = await context.routerClient.get<RouterOSRecord>("ip/service", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allServices as Record<string, string>[]).find((s) => s.name === parsed.name);

      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "IP_SERVICE_NOT_FOUND",
          message: `IP service "${parsed.name}" not found on router.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify service name with list_ip_services.",
            alternativeTools: ["list_ip_services"],
          },
        });
      }

      // Already in desired state — idempotent no-op
      const isCurrentlyDisabled = (existing as Record<string, unknown>).disabled === "true" || (existing as Record<string, unknown>).disabled === true;
      const wouldBeDisabled = parsed.action === "disable";
      if (isCurrentlyDisabled === wouldBeDisabled) {
        const alreadyState = parsed.action === "disable" ? "disabled" : "enabled";
        return {
          content: `IP service "${parsed.name}" is already ${alreadyState}. No changes made.`,
          structuredContent: { action: "no_change", name: parsed.name, id: existing[".id"] },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} IP service "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [
              {
                property: "disabled",
                before: existing.disabled,
                after: parsed.action === "disable" ? "true" : "false",
              },
            ],
          },
        };
      }

      const disabledValue = parsed.action === "disable" ? "true" : "false";
      await context.routerClient.update("ip/service", existing[".id"], { disabled: disabledValue });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "IP service updated");
      return {
        content: `IP service "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_ip_service" });
    }
  },
};

export const ipServiceTools: ToolDefinition[] = [listIpServicesTool, manageIpServiceTool];

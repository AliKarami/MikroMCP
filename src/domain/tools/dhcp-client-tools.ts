import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listSummary } from "./pagination.js";

const log = createLogger("dhcp-client-tools");

const listDhcpClientsInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Filter by interface name (exact match)"),
    status: z
      .enum(["bound", "searching", "requesting", "init", "all"])
      .default("all")
      .describe("Filter by DHCP client status"),
    limit,
    offset,
  })
  .strict();

const listDhcpClientsTool: ToolDefinition = {
  name: "list_dhcp_clients",
  title: "List DHCP Clients",
  description:
    "List DHCP client configurations on a MikroTik router. Shows which interfaces obtain their IP via DHCP, current status, and assigned address.",
  inputSchema: listDhcpClientsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listDhcpClientsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing DHCP clients");
    try {
      const allClients = await context.routerClient.get<RouterOSRecord>("ip/dhcp-client", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allClients as Record<string, unknown>[];

      if (parsed.interface) {
        filtered = filtered.filter((c) => c.interface === parsed.interface);
      }

      if (parsed.status !== "all") {
        filtered = filtered.filter((c) => c.status === parsed.status);
      }

      const { items: clients, total, hasMore } = paginate(filtered, parsed.offset, parsed.limit);

      return {
        content: listSummary("DHCP clients", context.routerId, clients.length, total, parsed.offset),
        structuredContent: {
          routerId: context.routerId,
          clients,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_dhcp_clients");
    }
  },
};

const manageDhcpClientInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    interface: z.string().describe("Interface name — idempotency key (e.g. ether1, ether2)"),
    usePeerDns: z.boolean().default(true).describe("Use DNS servers provided by DHCP server (add only)"),
    usePeerNtp: z.boolean().default(false).describe("Use NTP servers provided by DHCP server (add only)"),
    addDefaultRoute: z.boolean().default(true).describe("Add default route from DHCP (add only)"),
    comment: z.string().max(255).optional().describe("Optional comment (add only)"),
    dryRun,
  })
  .strict();

const manageDhcpClientTool: ToolDefinition = {
  name: "manage_dhcp_client",
  title: "Manage DHCP Client",
  description:
    "Add, remove, enable, or disable a DHCP client on an interface. Idempotent by interface name: add returns already_exists if a DHCP client is already configured on the same interface.",
  inputSchema: manageDhcpClientInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/dhcp-client"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageDhcpClientInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, interface: parsed.interface }, "Managing DHCP client");

    try {
      const allClients = await context.routerClient.get<RouterOSRecord>("ip/dhcp-client", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allClients as Record<string, string>[]).find(
        (c) => c.interface === parsed.interface,
      );

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `DHCP client already configured on "${parsed.interface}". No changes made.`,
            structuredContent: { action: "already_exists", client: existing },
          };
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "interface", before: null, after: parsed.interface },
            { property: "use-peer-dns", before: null, after: parsed.usePeerDns ? "yes" : "no" },
            { property: "use-peer-ntp", before: null, after: parsed.usePeerNtp ? "yes" : "no" },
            { property: "add-default-route", before: null, after: parsed.addDefaultRoute ? "yes" : "no" },
          ];
          return {
            content: `Dry run: Would add DHCP client on "${parsed.interface}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          interface: parsed.interface,
          "use-peer-dns": parsed.usePeerDns ? "yes" : "no",
          "use-peer-ntp": parsed.usePeerNtp ? "yes" : "no",
          "add-default-route": parsed.addDefaultRoute ? "yes" : "no",
        };
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("ip/dhcp-client", body);
        log.info({ interface: parsed.interface, id: created[".id"] }, "DHCP client added");
        return {
          content: `Added DHCP client on "${parsed.interface}".`,
          structuredContent: { action: "created", client: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `No DHCP client found on "${parsed.interface}". Nothing to remove.`,
            structuredContent: { action: "not_found", interface: parsed.interface },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove DHCP client on "${parsed.interface}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "interface", before: parsed.interface, after: null }],
            },
          };
        }
        await context.routerClient.remove("ip/dhcp-client", existing[".id"]);
        log.info({ interface: parsed.interface }, "DHCP client removed");
        return {
          content: `Removed DHCP client on "${parsed.interface}".`,
          structuredContent: { action: "removed", interface: parsed.interface, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "DHCP_CLIENT_NOT_FOUND",
          message: `No DHCP client found on interface "${parsed.interface}".`,
          details: { interface: parsed.interface },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify with list_dhcp_clients.",
            alternativeTools: ["list_dhcp_clients"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} DHCP client on "${parsed.interface}".`,
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
      await context.routerClient.update("ip/dhcp-client", existing[".id"], { disabled: disabledValue });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ interface: parsed.interface, action: resultAction }, "DHCP client updated");
      return {
        content: `DHCP client on "${parsed.interface}" ${resultAction}.`,
        structuredContent: { action: resultAction, interface: parsed.interface, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dhcp_client");
    }
  },
};

export const dhcpClientTools: ToolDefinition[] = [listDhcpClientsTool, manageDhcpClientTool];

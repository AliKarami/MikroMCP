import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("dhcp-server-tools");

const listDhcpServersInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Filter by interface name (exact match)"),
    limit,
    offset,
  })
  .strict();

const listDhcpServersTool: ToolDefinition = {
  name: "list_dhcp_servers",
  title: "List DHCP Servers",
  description: "List DHCP servers on a MikroTik router.",
  inputSchema: listDhcpServersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listDhcpServersInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing DHCP servers");
    try {
      const allServers = await context.routerClient.get<RouterOSRecord>("ip/dhcp-server", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = parsed.interface
        ? (allServers as Record<string, string>[]).filter((s) => s.interface === parsed.interface)
        : (allServers as Record<string, string>[]);

      const { items: servers, total, hasMore } = paginate(filtered, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "DHCP servers",
          context.routerId,
          servers,
          total,
          parsed.offset,
          (s) => compactFields(s, ["name", "interface", "address-pool", "lease-time", "disabled"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          servers,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_dhcp_servers");
    }
  },
};

const manageDhcpServerInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Server name — idempotency key"),
    interface: z.string().optional().describe("Interface to serve DHCP on (required for add)"),
    addressPool: z.string().optional().describe("IP pool name (required for add)"),
    leaseTime: z.string().optional().describe("Lease duration (e.g. '1d', '12h')"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageDhcpServerTool: ToolDefinition = {
  name: "manage_dhcp_server",
  title: "Manage DHCP Server",
  description:
    "Add, remove, enable, or disable a DHCP server. Idempotent by name: add returns already_exists if a server with the same name, interface, and address pool already exists.",
  inputSchema: manageDhcpServerInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/dhcp-server"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageDhcpServerInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing DHCP server",
    );
    try {
      const allServers = await context.routerClient.get<RouterOSRecord>("ip/dhcp-server", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allServers as Record<string, string>[]).find(
        (s) => s.name === parsed.name,
      );

      if (parsed.action === "add") {
        if (!parsed.interface) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DHCP_SERVER_INTERFACE_REQUIRED",
            message: "interface is required when adding a DHCP server.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the interface name to serve DHCP on.",
            },
          });
        }

        if (!parsed.addressPool) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DHCP_SERVER_POOL_REQUIRED",
            message: "addressPool is required when adding a DHCP server.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the address pool name.",
            },
          });
        }

        if (existing) {
          if (
            existing.interface === parsed.interface &&
            existing["address-pool"] === parsed.addressPool
          ) {
            return {
              content: `DHCP server "${parsed.name}" already exists with the same interface and pool. No changes made.`,
              structuredContent: { action: "already_exists", server: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "DHCP_SERVER_CONFLICT",
            message: `DHCP server "${parsed.name}" exists with different configuration.`,
            details: {
              existing: {
                interface: existing.interface,
                addressPool: existing["address-pool"],
              },
              requested: {
                interface: parsed.interface,
                addressPool: parsed.addressPool,
              },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing server first or use a different name.",
              alternativeTools: ["manage_dhcp_server"],
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "interface", before: null, after: parsed.interface },
            { property: "address-pool", before: null, after: parsed.addressPool },
            ...(parsed.leaseTime
              ? [{ property: "lease-time", before: null, after: parsed.leaseTime }]
              : []),
            ...(parsed.comment
              ? [{ property: "comment", before: null, after: parsed.comment }]
              : []),
          ];
          return {
            content: `Dry run: Would add DHCP server "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          interface: parsed.interface,
          "address-pool": parsed.addressPool,
        };
        if (parsed.leaseTime) body["lease-time"] = parsed.leaseTime;
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("ip/dhcp-server", body);
        log.info({ name: parsed.name, id: created[".id"] }, "DHCP server added");
        return {
          content: `Added DHCP server "${parsed.name}".`,
          structuredContent: { action: "created", server: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `DHCP server "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove DHCP server "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("ip/dhcp-server", existing[".id"]);
        log.info({ name: parsed.name }, "DHCP server removed");
        return {
          content: `Removed DHCP server "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "DHCP_SERVER_NOT_FOUND",
          message: `DHCP server "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the server name with list_dhcp_servers.",
            alternativeTools: ["list_dhcp_servers"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} DHCP server "${parsed.name}".`,
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
      await context.routerClient.update("ip/dhcp-server", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "DHCP server updated");
      return {
        content: `DHCP server "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dhcp_server");
    }
  },
};

export const dhcpServerTools: ToolDefinition[] = [listDhcpServersTool, manageDhcpServerTool];

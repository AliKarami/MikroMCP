// ---------------------------------------------------------------------------
// MikroMCP - DHCP lease management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate } from "./pagination.js";

const log = createLogger("dhcp-tools");

// ---------------------------------------------------------------------------
// list_dhcp_leases
// ---------------------------------------------------------------------------

const listDhcpLeasesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    server: z.string().optional().describe("Filter by DHCP server name"),
    status: z
      .enum(["bound", "waiting", "offered", "blocked", "all"])
      .default("all")
      .describe("Filter by lease status"),
    macAddress: z
      .string()
      .optional()
      .describe("Filter by MAC address (exact match, case-insensitive)"),
    leaseType: z
      .enum(["dynamic", "static", "all"])
      .default("all")
      .describe("Filter by lease type (dynamic or static)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of leases to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  })
  .strict();

const listDhcpLeasesTool: ToolDefinition = {
  name: "list_dhcp_leases",
  title: "List DHCP Leases",
  description:
    "List DHCP leases on a MikroTik router with optional filtering by server, status, lease type (dynamic/static), and MAC address. Supports pagination.",
  inputSchema: listDhcpLeasesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listDhcpLeasesInputSchema.parse(params);

    log.info(
      {
        routerId: context.routerId,
        server: parsed.server,
        status: parsed.status,
        macAddress: parsed.macAddress,
      },
      "Listing DHCP leases",
    );

    try {
      let leases = await context.routerClient.get<RouterOSRecord>("ip/dhcp-server/lease", {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.server) {
        leases = leases.filter((lease) => {
          const rec = lease as Record<string, unknown>;
          return rec.server === parsed.server;
        });
      }

      if (parsed.status !== "all") {
        leases = leases.filter((lease) => {
          const rec = lease as Record<string, unknown>;
          return rec.status === parsed.status;
        });
      }

      if (parsed.macAddress) {
        const upperMac = parsed.macAddress.toUpperCase();
        leases = leases.filter((lease) => {
          const rec = lease as Record<string, unknown>;
          const leaseMAC = (rec["mac-address"] ?? "").toString().toUpperCase();
          return leaseMAC === upperMac;
        });
      }

      if (parsed.leaseType !== "all") {
        leases = leases.filter((lease) => {
          const rec = lease as Record<string, unknown>;
          const isDynamic = rec.dynamic === true || rec.dynamic === "true";
          if (parsed.leaseType === "dynamic") return isDynamic;
          return !isDynamic; // static
        });
      }

      const { items: paginated, total, hasMore } = paginate(leases, parsed.offset, parsed.limit);

      const lines: string[] = [
        `DHCP leases on ${context.routerId}: ${total} total, showing ${paginated.length} (offset ${parsed.offset})`,
      ];

      for (const lease of paginated) {
        const rec = lease as Record<string, unknown>;

        const address = rec.address ?? rec["active-address"] ?? "unknown";

        const macAddress = rec["mac-address"] ?? rec["active-mac-address"] ?? "unknown";

        const hostname = rec["host-name"];
        const hostnameStr = hostname && hostname !== "" ? ` (${hostname})` : "";

        const status = rec.status ?? "unknown";

        lines.push(`  ${address}  ${macAddress}${hostnameStr}  [${status}]`);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          leases: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_dhcp_leases");
    }
  },
};

const manageDhcpLeaseInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z
      .enum(["make-static", "remove"])
      .describe(
        "Action to perform: make-static converts a dynamic lease to static; remove deletes the lease",
      ),
    macAddress: z
      .string()
      .describe("MAC address of the lease — idempotency key (case-insensitive)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageDhcpLeaseTool: ToolDefinition = {
  name: "manage_dhcp_lease",
  title: "Manage DHCP Lease",
  description:
    "Convert a dynamic DHCP lease to static (make-static) or remove a lease. Idempotent by MAC address.",
  inputSchema: manageDhcpLeaseInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/dhcp-server/lease"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageDhcpLeaseInputSchema.parse(params);
    const upperMac = parsed.macAddress.toUpperCase();

    log.info(
      { routerId: context.routerId, action: parsed.action, macAddress: upperMac },
      "Managing DHCP lease",
    );

    try {
      const allLeases = await context.routerClient.get<RouterOSRecord>("ip/dhcp-server/lease", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allLeases as Record<string, string>[]).find(
        (l) => (l["mac-address"] ?? "").toUpperCase() === upperMac,
      );

      if (parsed.action === "make-static") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "DHCP_LEASE_NOT_FOUND",
            message: `No DHCP lease found for MAC address ${upperMac}.`,
            details: { macAddress: upperMac },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the MAC address with list_dhcp_leases.",
              alternativeTools: ["list_dhcp_leases"],
            },
          });
        }

        // Already static — idempotent return
        const existingDynamic = (existing as Record<string, unknown>).dynamic;
        const isAlreadyStatic = existingDynamic === "false" || existingDynamic === false;
        if (isAlreadyStatic) {
          return {
            content: `Lease for ${upperMac} (${existing.address ?? "unknown"}) is already static. No changes made.`,
            structuredContent: { action: "already_static", macAddress: upperMac, id: existing[".id"] },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would convert lease for ${upperMac} (${existing.address ?? "unknown"}) to static.`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "dynamic", before: "true", after: "false" }],
              lease: existing,
            },
          };
        }

        await context.routerClient.update("ip/dhcp-server/lease", existing[".id"], {
          dynamic: "false",
        });
        log.info({ macAddress: upperMac, id: existing[".id"] }, "DHCP lease converted to static");
        return {
          content: `Lease for ${upperMac} (${existing.address ?? "unknown"}) converted to static.`,
          structuredContent: { action: "made-static", macAddress: upperMac, id: existing[".id"] },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `No DHCP lease found for MAC address ${upperMac}. Nothing to remove.`,
          structuredContent: { action: "not_found", macAddress: upperMac },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove lease for ${upperMac}.`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "mac-address", before: upperMac, after: null }],
          },
        };
      }
      await context.routerClient.remove("ip/dhcp-server/lease", existing[".id"]);
      log.info({ macAddress: upperMac }, "DHCP lease removed");
      return {
        content: `Removed DHCP lease for ${upperMac}.`,
        structuredContent: { action: "removed", macAddress: upperMac, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dhcp_lease");
    }
  },
};

export const dhcpTools: ToolDefinition[] = [listDhcpLeasesTool, manageDhcpLeaseTool];

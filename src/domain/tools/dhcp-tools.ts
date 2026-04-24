// ---------------------------------------------------------------------------
// MikroMCP - DHCP lease management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("dhcp-tools");

// ---------------------------------------------------------------------------
// list_dhcp_leases
// ---------------------------------------------------------------------------

const listDhcpLeasesInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  server: z.string().optional()
    .describe("Filter by DHCP server name"),
  status: z.enum(["bound", "waiting", "offered", "blocked", "all"]).default("all")
    .describe("Filter by lease status"),
  macAddress: z.string().optional()
    .describe("Filter by MAC address (exact match, case-insensitive)"),
  limit: z.number().int().min(1).max(500).default(100)
    .describe("Maximum number of leases to return"),
  offset: z.number().int().min(0).default(0)
    .describe("Offset for pagination"),
}).strict();

const listDhcpLeasesTool: ToolDefinition = {
  name: "list_dhcp_leases",
  title: "List DHCP Leases",
  description:
    "List DHCP leases on a MikroTik router with optional filtering by server, status, and MAC address. Supports pagination.",
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

      const total = leases.length;

      const paginated = leases.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

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
      throw enrichError(err, { routerId: context.routerId, tool: "list_dhcp_leases" });
    }
  },
};

export const dhcpTools: ToolDefinition[] = [listDhcpLeasesTool];

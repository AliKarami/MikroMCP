import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("routing-protocol-tools");

const listBgpPeersInputSchema = z
  .object({
    routerId,
    state: z
      .string()
      .optional()
      .describe("Filter by session state (e.g. established, active, idle)"),
  })
  .strict();

const listBgpPeersTool: ToolDefinition = {
  name: "list_bgp_peers",
  title: "List BGP Peers",
  description:
    "List BGP sessions on a MikroTik router (RouterOS 7+). Returns state, remote AS, prefix counts, and uptime.",
  inputSchema: listBgpPeersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listBgpPeersInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing BGP sessions");

    try {
      let sessions = await context.routerClient.get<RouterOSRecord>("routing/bgp/session", {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.state !== undefined) {
        sessions = sessions.filter((s) => (s as Record<string, string>).state === parsed.state);
      }

      return {
        content: listContent(
          "BGP sessions",
          context.routerId,
          sessions as Record<string, string>[],
          sessions.length,
          0,
          (s) => compactFields(s, ["name", "remote.address", "remote.as", "established", "uptime"]),
        ),
        structuredContent: { routerId: context.routerId, sessions, total: sessions.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_bgp_peers");
    }
  },
};

const listOspfNeighborsInputSchema = z
  .object({
    routerId,
    state: z.string().optional().describe("Filter by neighbor state (e.g. full, 2-way, init)"),
  })
  .strict();

const listOspfNeighborsTool: ToolDefinition = {
  name: "list_ospf_neighbors",
  title: "List OSPF Neighbors",
  description:
    "List OSPF neighbors on a MikroTik router (RouterOS 7+). Returns neighbor state, interface, DR/BDR, and uptime.",
  inputSchema: listOspfNeighborsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listOspfNeighborsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing OSPF neighbors");

    try {
      let neighbors = await context.routerClient.get<RouterOSRecord>("routing/ospf/neighbor", {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.state !== undefined) {
        neighbors = neighbors.filter((n) => (n as Record<string, string>).state === parsed.state);
      }

      return {
        content: listContent(
          "OSPF neighbors",
          context.routerId,
          neighbors as Record<string, string>[],
          neighbors.length,
          0,
          (n) => compactFields(n, ["instance", "router-id", "address", "state", "state-changes"]),
        ),
        structuredContent: { routerId: context.routerId, neighbors, total: neighbors.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_ospf_neighbors");
    }
  },
};

export const routingProtocolTools: ToolDefinition[] = [listBgpPeersTool, listOspfNeighborsTool];

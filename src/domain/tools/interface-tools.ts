import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("interface-tools");

const listInputSchema = z
  .object({
    routerId,
    type: z
      .enum(["ether", "vlan", "bridge", "bonding", "wireguard", "gre", "all"])
      .default("all")
      .describe("Filter by interface type"),
    status: z.enum(["up", "down", "all"]).default("all").describe("Filter by running status"),
    macAddress: z
      .string()
      .optional()
      .describe("Filter by MAC address (case-insensitive exact match on mac-address field)"),
    includeCounters: z
      .boolean()
      .default(false)
      .describe("Include traffic counters (tx-byte, rx-byte, etc.)"),
    limit,
    offset,
  })
  .strict();

const COUNTER_PROPS = [
  "tx-byte",
  "rx-byte",
  "tx-packet",
  "rx-packet",
  "tx-drop",
  "rx-drop",
  "tx-error",
  "rx-error",
  "tx-queue-drop",
  "fp-tx-byte",
  "fp-rx-byte",
  "fp-tx-packet",
  "fp-rx-packet",
  "fp-rps-drop",
];

const listInterfacesTool: ToolDefinition = {
  name: "list_interfaces",
  title: "List Interfaces",
  description:
    "List network interfaces on a MikroTik router with optional filtering by type and status. Supports pagination and optional traffic counters.",
  inputSchema: listInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listInputSchema.parse(params);

    log.info(
      { routerId: context.routerId, type: parsed.type, status: parsed.status },
      "Listing interfaces",
    );

    try {
      const path = parsed.type === "all" ? "interface" : `interface/${parsed.type}`;

      let interfaces = await context.routerClient.get<RouterOSRecord>(path, {
        limit: undefined, // Fetch all, then paginate
        offset: undefined,
      });

      if (parsed.macAddress !== undefined) {
        const target = parsed.macAddress.toLowerCase();
        interfaces = interfaces.filter((iface) => {
          const rec = iface as Record<string, string>;
          return (rec["mac-address"] ?? "").toLowerCase() === target;
        });
      }

      // Filter by status client-side
      if (parsed.status !== "all") {
        interfaces = interfaces.filter((iface) => {
          const running = (iface as Record<string, unknown>).running;
          const isUp = isTrue(running);
          if (parsed.status === "up") return isUp;
          if (parsed.status === "down") return !isUp;
          return true;
        });
      }

      const { items: paginated, total, hasMore } = paginate(interfaces, parsed.offset, parsed.limit);

      // Strip counters if not requested and add computed status field
      const results = paginated.map((iface) => {
        const rec = iface as Record<string, unknown>;
        const isRunning = isTrue(rec.running);
        const isDisabled = isTrue(rec.disabled);
        const enriched: Record<string, unknown> = { status: isDisabled ? "disabled" : isRunning ? "up" : "down" };
        for (const [key, value] of Object.entries(rec)) {
          if (parsed.includeCounters || !COUNTER_PROPS.includes(key)) {
            enriched[key] = value;
          }
        }
        return enriched;
      });

      return {
        content: listContent(
          "Interfaces",
          context.routerId,
          results,
          total,
          parsed.offset,
          (i) => compactFields(i, ["name", "type", "running", "disabled", "mtu", "comment"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          interfaces: results,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_interfaces");
    }
  },
};

export const interfaceTools: ToolDefinition[] = [listInterfacesTool];

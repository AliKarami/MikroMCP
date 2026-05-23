import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("interface-tools");

const listInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of interfaces to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
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
          const isUp = running === true || running === "true";
          if (parsed.status === "up") return isUp;
          if (parsed.status === "down") return !isUp;
          return true;
        });
      }

      const total = interfaces.length;

      // Apply pagination
      const paginated = interfaces.slice(parsed.offset, parsed.offset + parsed.limit);

      // Strip counters if not requested and add computed status field
      const results = paginated.map((iface) => {
        const rec = iface as Record<string, unknown>;
        const isRunning = rec.running === true || rec.running === "true";
        const isDisabled = rec.disabled === true || rec.disabled === "true";
        const enriched: Record<string, unknown> = { status: isDisabled ? "disabled" : isRunning ? "up" : "down" };
        for (const [key, value] of Object.entries(rec)) {
          if (parsed.includeCounters || !COUNTER_PROPS.includes(key)) {
            enriched[key] = value;
          }
        }
        return enriched;
      });

      const hasMore = parsed.offset + parsed.limit < total;

      const lines: string[] = [
        `Interfaces on ${context.routerId}: ${total} total, showing ${results.length} (offset ${parsed.offset})`,
      ];
      for (const iface of results) {
        const rec = iface as Record<string, unknown>;
        const name = rec.name ?? rec[".id"] ?? "unknown";
        const type = rec.type ?? parsed.type;
        const status = String(rec.status).toUpperCase();
        lines.push(`  ${name} [${type}] ${status}`);
      }

      return {
        content: lines.join("\n"),
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
      throw enrichError(err, { routerId: context.routerId, tool: "list_interfaces" });
    }
  },
};

export const interfaceTools: ToolDefinition[] = [listInterfacesTool];

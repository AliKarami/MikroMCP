import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("diagnostic-tools");

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

const pingInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  address: z.string().describe("Target IP address or hostname to ping"),
  count: z.number().int().min(1).max(20).default(4).describe("Number of ICMP echo requests (1–20)"),
  size: z.number().int().min(14).max(65535).default(56).describe("Packet size in bytes (14–65535)"),
  routingTable: z.string().optional().describe("Routing table to use for the ping"),
}).strict();

const pingTool: ToolDefinition = {
  name: "ping",
  title: "Ping",
  description:
    "Send ICMP echo requests from the router to a target address. Returns per-packet RTT and summary statistics. 100% packet loss is a valid result, not an error.",
  inputSchema: pingInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = pingInputSchema.parse(params);

    log.info({ routerId: context.routerId, address: parsed.address }, "Pinging");

    try {
      const body: Record<string, string> = {
        address: parsed.address,
        count: String(parsed.count),
        "packet-size": String(parsed.size),
      };
      if (parsed.routingTable !== undefined) body["routing-table"] = parsed.routingTable;

      const results = await context.routerClient.execute<Record<string, string>[]>("tool/ping", body);
      const rows = Array.isArray(results) ? results : [results as Record<string, string>];
      const summary = rows[0] ?? {};

      const packetLoss = summary["packet-loss"] ?? "?";
      const avgRtt = summary["avg-rtt"] ?? "?";
      const sent = summary.sent ?? String(parsed.count);
      const received = summary.received ?? "?";

      const content = `Ping ${parsed.address} from ${context.routerId}: sent=${sent} received=${received} loss=${packetLoss} avg=${avgRtt}`;

      return {
        content,
        structuredContent: {
          routerId: context.routerId,
          address: parsed.address,
          sent: Number(sent),
          received: Number(received),
          packetLoss,
          minRtt: summary["min-rtt"] ?? null,
          avgRtt,
          maxRtt: summary["max-rtt"] ?? null,
          raw: rows,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "ping" });
    }
  },
};

// ---------------------------------------------------------------------------
// traceroute
// ---------------------------------------------------------------------------

const tracerouteInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  address: z.string().describe("Target IP address or hostname to trace"),
  count: z.number().int().min(1).max(5).default(3).describe("Probes per hop (1–5)"),
  maxHops: z.number().int().min(1).max(30).default(15).describe("Maximum number of hops (1–30)"),
}).strict();

const tracerouteTool: ToolDefinition = {
  name: "traceroute",
  title: "Traceroute",
  description:
    "Trace the network path from the router to a target address. Returns an ordered hop list with RTT per hop. Timeouts and partial results are valid responses.",
  inputSchema: tracerouteInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = tracerouteInputSchema.parse(params);

    log.info({ routerId: context.routerId, address: parsed.address }, "Tracerouting");

    try {
      const body: Record<string, string> = {
        address: parsed.address,
        count: String(parsed.count),
        "max-hops": String(parsed.maxHops),
      };

      const results = await context.routerClient.execute<Record<string, string>[]>("tool/traceroute", body);
      const hops = Array.isArray(results) ? results : [];

      const lines = [`Traceroute to ${parsed.address} from ${context.routerId}:`];
      hops.forEach((hop, i) => {
        const addr = hop.address ?? "???";
        const avg = hop.avg ?? "?";
        lines.push(`  ${i + 1}  ${addr}  ${avg}`);
      });

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          address: parsed.address,
          hops,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "traceroute" });
    }
  },
};

export const diagnosticTools: ToolDefinition[] = [pingTool, tracerouteTool];

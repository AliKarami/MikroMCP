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

// ---------------------------------------------------------------------------
// torch
// ---------------------------------------------------------------------------

const torchInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  interface: z.string().describe("Interface name to monitor (e.g. ether1, bridge1)"),
  duration: z.number().int().min(1).max(30).default(5).describe("Capture duration in seconds (1–30)"),
  srcAddress: z.string().optional().describe("Filter by source IP address"),
  dstAddress: z.string().optional().describe("Filter by destination IP address"),
}).strict();

const torchTool: ToolDefinition = {
  name: "torch",
  title: "Torch",
  description:
    "Capture a real-time traffic snapshot on a router interface. The tool call blocks for the duration (seconds) and returns top flows by bytes. readOnlyHint true — auto-retry enabled.",
  inputSchema: torchInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = torchInputSchema.parse(params);

    log.info({ routerId: context.routerId, interface: parsed.interface }, "Running torch");

    try {
      const body: Record<string, string> = {
        interface: parsed.interface,
        duration: String(parsed.duration),
      };
      if (parsed.srcAddress !== undefined) body["src-address"] = parsed.srcAddress;
      if (parsed.dstAddress !== undefined) body["dst-address"] = parsed.dstAddress;

      const results = await context.routerClient.execute<Record<string, string>[]>("tool/torch", body);
      const flows = Array.isArray(results) ? results : [];

      const lines = [`Torch on ${parsed.interface} (${parsed.duration}s) from ${context.routerId}: ${flows.length} flows`];
      for (const flow of flows.slice(0, 10)) {
        const src = flow.src ?? flow["src-address"] ?? "?";
        const dst = flow.dst ?? flow["dst-address"] ?? "?";
        const tx = flow["tx-bytes"] ?? "?";
        const rx = flow["rx-bytes"] ?? "?";
        lines.push(`  ${src} → ${dst}  tx=${tx} rx=${rx}`);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          interface: parsed.interface,
          duration: parsed.duration,
          flows,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "torch" });
    }
  },
};

// ---------------------------------------------------------------------------
// get_log
// ---------------------------------------------------------------------------

const getLogInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum entries to return (1–500)"),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  topics: z.array(z.string()).optional()
    .describe("Filter entries whose topics field contains any of these strings (e.g. [\"firewall\", \"dhcp\"])"),
  prefix: z.string().optional()
    .describe("Substring to match against the log message"),
  sinceMinutes: z.number().int().min(1).max(1440).optional()
    .describe("Only return entries from the last N minutes (1–1440)"),
}).strict();

function parseRouterOsTimestamp(ts: string, now: Date): Date | null {
  const timeOnly = /^(\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (timeOnly) {
    const d = new Date(now);
    d.setHours(parseInt(timeOnly[1], 10), parseInt(timeOnly[2], 10), parseInt(timeOnly[3], 10), 0);
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const monthDay = /^([a-z]{3})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/i.exec(ts);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    if (month === undefined) return null;
    const d = new Date(
      now.getFullYear(),
      month,
      parseInt(monthDay[2], 10),
      parseInt(monthDay[3], 10),
      parseInt(monthDay[4], 10),
      parseInt(monthDay[5], 10),
    );
    if (d > now) d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  return null;
}

const getLogTool: ToolDefinition = {
  name: "get_log",
  title: "Get Log",
  description:
    "Read and filter the system log from a MikroTik router. Supports filtering by topic, message prefix, and a time window (last N minutes). Entries with unparseable timestamps are included conservatively.",
  inputSchema: getLogInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getLogInputSchema.parse(params);

    log.info({ routerId: context.routerId, topics: parsed.topics, sinceMinutes: parsed.sinceMinutes }, "Getting log");

    try {
      const allEntries = await context.routerClient.get<Record<string, string>>("log");
      const now = new Date();
      const cutoff = parsed.sinceMinutes !== undefined
        ? new Date(now.getTime() - parsed.sinceMinutes * 60_000)
        : null;

      let filtered = allEntries.map((e) => e as Record<string, string>);

      if (parsed.topics && parsed.topics.length > 0) {
        filtered = filtered.filter((e) => {
          const entryTopics = e.topics ?? "";
          return parsed.topics!.some((t) => entryTopics.includes(t));
        });
      }

      if (parsed.prefix) {
        const lower = parsed.prefix.toLowerCase();
        filtered = filtered.filter((e) => (e.message ?? "").toLowerCase().includes(lower));
      }

      if (cutoff !== null) {
        filtered = filtered.filter((e) => {
          const ts = e.time ?? "";
          const parsedTs = parseRouterOsTimestamp(ts, now);
          if (parsedTs === null) return true;
          return parsedTs >= cutoff!;
        });
      }

      const total = filtered.length;
      const paginated = filtered.slice(parsed.offset, parsed.offset + parsed.limit);

      const lines = [
        `Log on ${context.routerId}: ${total} matching entries, showing ${paginated.length} (offset ${parsed.offset})`,
      ];
      for (const entry of paginated) {
        lines.push(`  [${entry.time ?? "?"}] [${entry.topics ?? "?"}] ${entry.message ?? ""}`);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          entries: paginated,
          total,
          hasMore: parsed.offset + parsed.limit < total,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "get_log" });
    }
  },
};

export const diagnosticTools: ToolDefinition[] = [pingTool, tracerouteTool, torchTool, getLogTool];

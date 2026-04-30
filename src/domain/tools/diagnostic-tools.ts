import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { SshClient } from "../../adapter/ssh-client.js";
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
      // RouterOS 7.x REST API for /tool/ping requires internal permissions that cannot
      // be granted via user policy. Use SSH instead, matching run_command behavior.
      const parts = [
        `/tool ping address=${parsed.address}`,
        `count=${parsed.count}`,
        `size=${parsed.size}`,
      ];
      if (parsed.routingTable !== undefined) parts.push(`routing-table=${parsed.routingTable}`);

      const ssh = new SshClient(context.routerConfig, context.credentials, context.sshOptions);
      const output = await ssh.execute(parts.join(" "));

      // Summary line: "sent=N received=N packet-loss=X% min-rtt=Xms avg-rtt=Xms max-rtt=Xms"
      const s = output.match(/sent=(\d+)/)?.[1] ?? String(parsed.count);
      const r = output.match(/received=(\d+)/)?.[1] ?? "0";
      const loss = output.match(/packet-loss=(\S+)/)?.[1] ?? "100%";
      const minRtt = output.match(/min-rtt=(\S+)/)?.[1] ?? null;
      const avgRtt = output.match(/avg-rtt=(\S+)/)?.[1] ?? "?";
      const maxRtt = output.match(/max-rtt=(\S+)/)?.[1] ?? null;

      return {
        content: `Ping ${parsed.address} from ${context.routerId}: sent=${s} received=${r} loss=${loss} avg=${avgRtt}`,
        structuredContent: {
          routerId: context.routerId,
          address: parsed.address,
          sent: Number(s),
          received: Number(r),
          packetLoss: loss,
          minRtt,
          avgRtt,
          maxRtt,
          raw: output,
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
      // Same REST API permission issue as ping — use SSH.
      const parts = [
        `/tool traceroute address=${parsed.address}`,
        `count=${parsed.count}`,
        `max-hops=${parsed.maxHops}`,
      ];

      const ssh = new SshClient(context.routerConfig, context.credentials, context.sshOptions);
      const output = await ssh.execute(parts.join(" "));

      // Each hop line starts with a number: " 1 192.168.1.1  echo reply  1ms …"
      const hopLines = output.split("\n").filter((l) => /^\s*\d+\s+\S+/.test(l));
      const hops = hopLines.map((line) => {
        const cols = line.trim().split(/\s+/);
        return {
          hop: Number(cols[0]),
          address: cols[1] ?? "???",
          status: cols[2] ?? "",
          rtt1: cols[3] ?? null,
          rtt2: cols[4] ?? null,
          rtt3: cols[5] ?? null,
        };
      });

      const lines = [`Traceroute to ${parsed.address} from ${context.routerId}:`];
      hops.forEach((h) => lines.push(`  ${h.hop}  ${h.address}  ${h.rtt1 ?? "?"}`));

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          address: parsed.address,
          hops,
          raw: output,
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

interface TorchFlow {
  src: string;
  dst: string;
  txBytes: string;
  rxBytes: string;
}

function parseTorchOutput(output: string): TorchFlow[] {
  const flows: TorchFlow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^(SRC|src|-{3})/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 4) continue;
    flows.push({
      src: cols[0] ?? "?",
      dst: cols[1] ?? "?",
      txBytes: cols[2] ?? "?",
      rxBytes: cols[3] ?? "?",
    });
  }
  return flows;
}

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
      const parts = [`/tool torch interface=${parsed.interface}`];
      if (parsed.srcAddress !== undefined) parts.push(`src-address=${parsed.srcAddress}`);
      if (parsed.dstAddress !== undefined) parts.push(`dst-address=${parsed.dstAddress}`);

      const ssh = new SshClient(context.routerConfig, context.credentials, context.sshOptions);
      // RouterOS torch runs indefinitely — force-close after duration + 1s buffer
      const raw = await ssh.execute(parts.join(" "), (parsed.duration + 1) * 1000);

      // Strip ANSI escape codes and parse flow rows
      // eslint-disable-next-line no-control-regex
      const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      const flows = parseTorchOutput(clean);

      const lines = [`Torch on ${parsed.interface} (${parsed.duration}s) from ${context.routerId}: ${flows.length} flows`];
      for (const flow of flows.slice(0, 10)) {
        lines.push(`  ${flow.src} → ${flow.dst}  tx=${flow.txBytes} rx=${flow.rxBytes}`);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          interface: parsed.interface,
          duration: parsed.duration,
          flows,
          raw,
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

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { limit, routerId } from "./schema-fields.js";
import { listContent, compactFields } from "./pagination.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("network-test-tools");
const BODY_CAP = 65536;

// ---------------------------------------------------------------------------
// bandwidth_test
// ---------------------------------------------------------------------------

const bandwidthTestInputSchema = z
  .object({
    routerId,
    address: z.string().describe("Remote host running RouterOS btest server"),
    protocol: z.enum(["tcp", "udp"]).default("tcp").describe("Test protocol"),
    direction: z.enum(["send", "receive", "both"]).default("both").describe("Test direction"),
    duration: z.number().int().min(1).max(20).default(5).describe("Test duration in seconds (max 20)"),
  })
  .strict();

const bandwidthTestTool: ToolDefinition = {
  name: "bandwidth_test",
  title: "Bandwidth Test",
  description:
    "Run a RouterOS bandwidth test from the router to a remote host running a RouterOS btest server. Returns TX and RX throughput in Mbps. Duration capped at 20 seconds. Saturates the link — not auto-retried.",
  inputSchema: bandwidthTestInputSchema,
  // Reaches an external host and saturates the link; a silent retry would
  // double the load, so opt out of auto-retry.
  retryable: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = bandwidthTestInputSchema.parse(params);
    log.info({ routerId: context.routerId, address: parsed.address }, "Running bandwidth test");
    try {
      const result = await context.routerClient.execute<Record<string, string>>("tool/bandwidth-test", {
        address: parsed.address,
        protocol: parsed.protocol,
        direction: parsed.direction,
        duration: String(parsed.duration),
      });
      const txBps = Number(result["tx-current"] ?? 0);
      const rxBps = Number(result["rx-current"] ?? 0);
      const txMbps = Math.round((txBps / 1_000_000) * 100) / 100;
      const rxMbps = Math.round((rxBps / 1_000_000) * 100) / 100;
      return {
        content: `Bandwidth test to ${parsed.address}: TX=${txMbps} Mbps RX=${rxMbps} Mbps`,
        structuredContent: {
          routerId: context.routerId,
          address: parsed.address,
          protocol: parsed.protocol,
          direction: parsed.direction,
          txMbps,
          rxMbps,
          lostPackets: result["lost-packets"] ?? null,
        },
      };
    } catch (err) {
      throw toolError(err, context, "bandwidth_test");
    }
  },
};

// ---------------------------------------------------------------------------
// fetch_url
// ---------------------------------------------------------------------------

const fetchUrlInputSchema = z
  .object({
    routerId,
    url: z.string().url().describe("URL to fetch from the router"),
    method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
    httpData: z.string().optional().describe("Request body for POST"),
    outputFile: z
      .string()
      .optional()
      .describe("Save response body to this router file path instead of returning inline"),
  })
  .strict();

const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  title: "Fetch URL",
  description:
    "Send an HTTP/HTTPS request from the router using /tool/fetch. Response body is returned inline (capped at 64 KB with [TRUNCATED] marker). Use outputFile to save to router filesystem instead. Not read-only: POSTs have side effects and outputFile writes to the router.",
  inputSchema: fetchUrlInputSchema,
  // Not read-only: a POST has external side effects and outputFile writes a
  // file on the router. openWorld: reaches arbitrary external hosts.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = fetchUrlInputSchema.parse(params);
    log.info({ routerId: context.routerId, url: parsed.url, method: parsed.method }, "Fetching URL");
    try {
      const body: Record<string, string> = { url: parsed.url, "http-method": parsed.method.toLowerCase() };
      if (parsed.httpData) body["http-data"] = parsed.httpData;
      if (parsed.outputFile) {
        body.output = "file";
        body["dst-path"] = parsed.outputFile;
      } else {
        body.output = "user";
      }

      const sections = await context.routerClient.execute<Record<string, string>[]>("tool/fetch", body);
      const finished = sections.find((s) => s.status === "finished") ?? sections[sections.length - 1];
      const statusCode = finished?.code ?? null;

      if (parsed.outputFile) {
        return {
          content: `Fetched ${parsed.url} → saved to ${parsed.outputFile} (status ${statusCode})`,
          structuredContent: { routerId: context.routerId, url: parsed.url, statusCode, outputFile: parsed.outputFile },
        };
      }

      let responseBody = finished?.data ?? "";
      if (responseBody.length > BODY_CAP) {
        responseBody = responseBody.slice(0, BODY_CAP) + "[TRUNCATED]";
      }
      return {
        content: `Fetched ${parsed.url}: status=${statusCode} body_length=${responseBody.length}`,
        structuredContent: { routerId: context.routerId, url: parsed.url, statusCode, body: responseBody },
      };
    } catch (err) {
      throw toolError(err, context, "fetch_url");
    }
  },
};

// ---------------------------------------------------------------------------
// list_connections
// ---------------------------------------------------------------------------

const listConnectionsInputSchema = z
  .object({
    routerId,
    srcAddress: z.string().optional().describe("Filter by source address (substring match)"),
    dstAddress: z.string().optional().describe("Filter by destination address (substring match)"),
    protocol: z.string().optional().describe("Filter by protocol (exact match, e.g. tcp, udp, icmp)"),
    limit,
  })
  .strict();

const listConnectionsTool: ToolDefinition = {
  name: "list_connections",
  title: "List Connections",
  description:
    "List active connection tracking entries from the router firewall table. Filters are applied client-side. Useful for diagnosing NAT and firewall behavior.",
  inputSchema: listConnectionsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listConnectionsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing connections");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("ip/firewall/connection", {
        proplist: [
          "protocol",
          "src-address",
          "dst-address",
          "tcp-state",
          "connection-mark",
          "timeout",
        ],
        limit: undefined,
        offset: undefined,
      });
      const filtered = (all as Record<string, string>[])
        .filter((c) => (parsed.srcAddress ? (c["src-address"] ?? "").includes(parsed.srcAddress) : true))
        .filter((c) => (parsed.dstAddress ? (c["dst-address"] ?? "").includes(parsed.dstAddress) : true))
        .filter((c) => (parsed.protocol ? c.protocol === parsed.protocol : true));
      const connections = filtered.slice(0, parsed.limit);
      return {
        content: listContent(
          "Active connections",
          context.routerId,
          connections,
          all.length,
          0,
          (c) =>
            compactFields(c, [
              "protocol",
              "src-address",
              "dst-address",
              "tcp-state",
              "connection-mark",
            ]),
        ),
        structuredContent: { routerId: context.routerId, connections, total: all.length, returned: connections.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_connections");
    }
  },
};

export const networkTestTools: ToolDefinition[] = [bandwidthTestTool, fetchUrlTool, listConnectionsTool];

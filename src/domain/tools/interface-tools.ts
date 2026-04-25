// ---------------------------------------------------------------------------
// MikroMCP - Network interface tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("interface-tools");

// ---------------------------------------------------------------------------
// list_interfaces
// ---------------------------------------------------------------------------

const listInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  type: z.enum(["ether", "vlan", "bridge", "bonding", "wireguard", "gre", "all"]).default("all")
    .describe("Filter by interface type"),
  status: z.enum(["up", "down", "all"]).default("all")
    .describe("Filter by running status"),
  macAddress: z.string().optional()
    .describe("Filter by MAC address (case-insensitive exact match on mac-address field)"),
  includeCounters: z.boolean().default(false)
    .describe("Include traffic counters (tx-byte, rx-byte, etc.)"),
  limit: z.number().int().min(1).max(500).default(100)
    .describe("Maximum number of interfaces to return"),
  offset: z.number().int().min(0).default(0)
    .describe("Offset for pagination"),
}).strict();

const COUNTER_PROPS = [
  "tx-byte", "rx-byte", "tx-packet", "rx-packet",
  "tx-drop", "rx-drop", "tx-error", "rx-error",
  "tx-queue-drop",
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

      // Strip counters if not requested
      const results = parsed.includeCounters
        ? paginated
        : paginated.map((iface) => {
            const cleaned: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(iface)) {
              if (!COUNTER_PROPS.includes(key)) {
                cleaned[key] = value;
              }
            }
            return cleaned;
          });

      const hasMore = parsed.offset + parsed.limit < total;

      const lines: string[] = [
        `Interfaces on ${context.routerId}: ${total} total, showing ${results.length} (offset ${parsed.offset})`,
      ];
      for (const iface of results) {
        const rec = iface as Record<string, string>;
        const name = rec.name ?? rec[".id"] ?? "unknown";
        const type = rec.type ?? parsed.type;
        const running = rec.running === "true" ? "UP" : "DOWN";
        lines.push(`  ${name} [${type}] ${running}`);
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

// ---------------------------------------------------------------------------
// create_vlan
// ---------------------------------------------------------------------------

const createVlanInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(15)
    .describe("VLAN interface name (alphanumeric, hyphens, underscores, max 15 chars)"),
  vlanId: z.number().int().min(1).max(4094)
    .describe("VLAN ID (1-4094)"),
  parentInterface: z.string()
    .describe("Parent interface name (e.g., ether1, bridge1)"),
  mtu: z.number().int().min(68).max(9000).default(1500)
    .describe("MTU size"),
  disabled: z.boolean().default(false)
    .describe("Whether the VLAN interface should be disabled"),
  comment: z.string().max(255).optional()
    .describe("Optional comment for the VLAN interface"),
  dryRun: z.boolean().default(false)
    .describe("If true, validate and return planned changes without applying"),
}).strict();

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

const createVlanTool: ToolDefinition = {
  name: "create_vlan",
  title: "Create VLAN Interface",
  description:
    "Create a new VLAN interface on a MikroTik router. Performs idempotency checks: if a VLAN with the same name already exists with matching configuration, returns success without changes. Supports dry-run mode.",
  inputSchema: createVlanInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = createVlanInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info(
      { routerId: context.routerId, name: parsed.name, vlanId: parsed.vlanId },
      "Creating VLAN interface",
    );

    try {
      // 1. Idempotency check: look for existing VLAN with same name
      const existing = await context.routerClient.get<RouterOSRecord>("interface/vlan", {
        filter: { name: parsed.name },
      });

      if (existing.length > 0) {
        const found = existing[0] as Record<string, string>;
        const existingVlanId = found["vlan-id"];
        const existingInterface = found.interface;

        // Same name, same config -> already exists
        if (existingVlanId === String(parsed.vlanId) && existingInterface === parsed.parentInterface) {
          log.info({ name: parsed.name }, "VLAN already exists with matching config");
          return {
            content: `VLAN "${parsed.name}" already exists with VLAN ID ${parsed.vlanId} on ${parsed.parentInterface}. No changes made.`,
            structuredContent: {
              action: "already_exists",
              vlan: found,
            },
          };
        }

        // Same name, different config -> conflict
        throw new MikroMCPError({
          category: ErrorCategory.CONFLICT,
          code: "VLAN_NAME_CONFLICT",
          message: `VLAN "${parsed.name}" already exists but with different configuration (vlan-id=${existingVlanId}, interface=${existingInterface}). Expected vlan-id=${parsed.vlanId}, interface=${parsed.parentInterface}.`,
          details: {
            existingVlanId,
            existingInterface,
            requestedVlanId: parsed.vlanId,
            requestedInterface: parsed.parentInterface,
          },
          recoverability: {
            retryable: false,
            suggestedAction: "Use a different name or update the existing VLAN.",
          },
        });
      }

      // 2. Dry run
      if (parsed.dryRun) {
        const diff = [
          { property: "name", before: null, after: parsed.name },
          { property: "vlan-id", before: null, after: String(parsed.vlanId) },
          { property: "interface", before: null, after: parsed.parentInterface },
          { property: "mtu", before: null, after: String(parsed.mtu) },
          { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
          ...(comment ? [{ property: "comment", before: null, after: comment }] : []),
        ];

        return {
          content: `Dry run: Would create VLAN "${parsed.name}" (ID ${parsed.vlanId}) on ${parsed.parentInterface} with MTU ${parsed.mtu}.`,
          structuredContent: {
            action: "dry_run",
            diff,
          },
        };
      }

      // 3. Create
      const body: Record<string, string> = {
        name: parsed.name,
        "vlan-id": String(parsed.vlanId),
        interface: parsed.parentInterface,
        mtu: String(parsed.mtu),
        disabled: parsed.disabled ? "true" : "false",
      };
      if (comment) {
        body.comment = comment;
      }

      const created = await context.routerClient.create("interface/vlan", body);

      log.info({ name: parsed.name, id: created[".id"] }, "VLAN created successfully");

      return {
        content: `Created VLAN "${parsed.name}" (ID ${parsed.vlanId}) on ${parsed.parentInterface} with MTU ${parsed.mtu}.`,
        structuredContent: {
          action: "created",
          vlan: created,
        },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "create_vlan" });
    }
  },
};

export const interfaceTools: ToolDefinition[] = [listInterfacesTool, createVlanTool];

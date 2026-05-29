import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate } from "./pagination.js";

const log = createLogger("bridge-tools");

const listBridgesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of bridges to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  })
  .strict();

const listBridgesTool: ToolDefinition = {
  name: "list_bridges",
  title: "List Bridges",
  description: "List bridge interfaces and their port members on a MikroTik router.",
  inputSchema: listBridgesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listBridgesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing bridges");
    try {
      const [bridges, ports] = await Promise.all([
        context.routerClient.get<RouterOSRecord>("interface/bridge"),
        context.routerClient.get<RouterOSRecord>("interface/bridge/port"),
      ]);

      const portsByBridge: Record<string, RouterOSRecord[]> = {};
      for (const port of ports) {
        const rec = port as Record<string, string>;
        const bridgeName = rec.bridge ?? "";
        if (!portsByBridge[bridgeName]) portsByBridge[bridgeName] = [];
        portsByBridge[bridgeName].push(port);
      }

      const enriched = bridges.map((b) => {
        const rec = b as Record<string, string>;
        return { ...rec, ports: portsByBridge[rec.name] ?? [] };
      });

      const { items: paginated, total, hasMore } = paginate(enriched, parsed.offset, parsed.limit);

      const lines = [`Bridges on ${context.routerId}: ${total} total`];
      for (const b of paginated) {
        const bRec = b as Record<string, unknown>;
        const portList = (b.ports as RouterOSRecord[])
          .map((p) => (p as Record<string, string>).interface)
          .join(", ");
        lines.push(
          `  ${String(bRec.name)} [${(b.ports as unknown[]).length} ports${portList ? ": " + portList : ""}]`,
        );
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          bridges: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_bridges");
    }
  },
};

const manageBridgeInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["create", "remove"]).describe("Action to perform"),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(15)
      .describe("Bridge interface name"),
    comment: z.string().max(255).optional().describe("Optional comment"),
    disabled: z.boolean().default(false).describe("Whether the bridge should be disabled"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageBridgeTool: ToolDefinition = {
  name: "manage_bridge",
  title: "Manage Bridge Interface",
  description:
    "Create or remove a bridge interface on a MikroTik router. Idempotent: create returns already_exists if bridge with same name exists.",
  inputSchema: manageBridgeInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/bridge"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageBridgeInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing bridge",
    );
    try {
      const existing = await context.routerClient.get<RouterOSRecord>("interface/bridge", {
        filter: { name: parsed.name },
      });

      if (parsed.action === "create") {
        if (existing.length > 0) {
          return {
            content: `Bridge "${parsed.name}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", bridge: existing[0] },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create bridge "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "name", before: null, after: parsed.name },
                { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
              ],
            },
          };
        }
        const body: Record<string, string> = {
          name: parsed.name,
          disabled: parsed.disabled ? "true" : "false",
        };
        if (parsed.comment) body.comment = parsed.comment.replace(/[\x00-\x1f\x7f]/g, "");
        const created = await context.routerClient.create("interface/bridge", body);
        log.info({ name: parsed.name, id: created[".id"] }, "Bridge created");
        return {
          content: `Created bridge "${parsed.name}".`,
          structuredContent: { action: "created", bridge: created },
        };
      }

      if (existing.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "BRIDGE_NOT_FOUND",
          message: `Bridge "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the bridge name exists on the router.",
          },
        });
      }
      const rec = existing[0] as Record<string, string>;
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove bridge "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/bridge", rec[".id"]);
      log.info({ name: parsed.name }, "Bridge removed");
      return {
        content: `Removed bridge "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: rec[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_bridge");
    }
  },
};

const manageBridgePortInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    bridge: z.string().describe("Bridge interface name"),
    interface: z.string().describe("Interface to add or remove as a bridge port"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageBridgePortTool: ToolDefinition = {
  name: "manage_bridge_port",
  title: "Manage Bridge Port",
  description:
    "Add or remove an interface from a bridge on a MikroTik router. Idempotent: add returns already_exists if the port assignment already exists.",
  inputSchema: manageBridgePortInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/bridge/port"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageBridgePortInputSchema.parse(params);
    log.info(
      {
        routerId: context.routerId,
        action: parsed.action,
        bridge: parsed.bridge,
        interface: parsed.interface,
      },
      "Managing bridge port",
    );
    try {
      const existing = await context.routerClient.get<RouterOSRecord>("interface/bridge/port", {
        filter: { bridge: parsed.bridge, interface: parsed.interface },
      });

      if (parsed.action === "add") {
        if (existing.length > 0) {
          return {
            content: `Interface "${parsed.interface}" is already a port on bridge "${parsed.bridge}". No changes made.`,
            structuredContent: { action: "already_exists", port: existing[0] },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add "${parsed.interface}" to bridge "${parsed.bridge}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "bridge", before: null, after: parsed.bridge },
                { property: "interface", before: null, after: parsed.interface },
              ],
            },
          };
        }
        const created = await context.routerClient.create("interface/bridge/port", {
          bridge: parsed.bridge,
          interface: parsed.interface,
        });
        log.info({ bridge: parsed.bridge, interface: parsed.interface }, "Bridge port added");
        return {
          content: `Added "${parsed.interface}" to bridge "${parsed.bridge}".`,
          structuredContent: { action: "created", port: created },
        };
      }

      if (existing.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "BRIDGE_PORT_NOT_FOUND",
          message: `Interface "${parsed.interface}" is not a port on bridge "${parsed.bridge}".`,
          details: { bridge: parsed.bridge, interface: parsed.interface },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the interface is a member of the bridge.",
          },
        });
      }
      const rec = existing[0] as Record<string, string>;
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove "${parsed.interface}" from bridge "${parsed.bridge}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "interface", before: parsed.interface, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/bridge/port", rec[".id"]);
      log.info({ bridge: parsed.bridge, interface: parsed.interface }, "Bridge port removed");
      return {
        content: `Removed "${parsed.interface}" from bridge "${parsed.bridge}".`,
        structuredContent: {
          action: "removed",
          bridge: parsed.bridge,
          interface: parsed.interface,
          id: rec[".id"],
        },
      };
    } catch (err) {
      throw toolError(err, context, "manage_bridge_port");
    }
  },
};

export const bridgeTools: ToolDefinition[] = [
  listBridgesTool,
  manageBridgeTool,
  manageBridgePortTool,
];

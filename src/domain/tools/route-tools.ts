// ---------------------------------------------------------------------------
// MikroMCP - Static route management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("route-tools");

// ---------------------------------------------------------------------------
// list_routes
// ---------------------------------------------------------------------------

const listRoutesInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  activeOnly: z.boolean().default(false)
    .describe("Return only active routes"),
  staticOnly: z.boolean().default(false)
    .describe("Return only non-dynamic routes"),
  limit: z.number().int().min(1).max(500).default(100)
    .describe("Maximum number of routes to return"),
  offset: z.number().int().min(0).default(0)
    .describe("Offset for pagination"),
}).strict();

const listRoutesTool: ToolDefinition = {
  name: "list_routes",
  title: "List Static Routes",
  description:
    "List static routes on a MikroTik router with optional filtering by active status and dynamic status. Supports pagination.",
  inputSchema: listRoutesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listRoutesInputSchema.parse(params);

    log.info(
      {
        routerId: context.routerId,
        activeOnly: parsed.activeOnly,
        staticOnly: parsed.staticOnly,
      },
      "Listing routes",
    );

    try {
      let routes = await context.routerClient.get<RouterOSRecord>("ip/route", {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.activeOnly) {
        routes = routes.filter((route) => {
          const rec = route as Record<string, unknown>;
          return rec.active === true || rec.active === "true";
        });
      }

      if (parsed.staticOnly) {
        routes = routes.filter((route) => {
          const rec = route as Record<string, unknown>;
          return rec.dynamic !== true && rec.dynamic !== "true";
        });
      }

      const total = routes.length;

      const paginated = routes.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      const lines: string[] = [
        `Routes on ${context.routerId}: ${total} total, showing ${paginated.length} (offset ${parsed.offset})`,
      ];

      for (const route of paginated) {
        const rec = route as Record<string, unknown>;

        const dstAddress = rec["dst-address"] ?? "unknown";
        const gateway = rec.gateway ?? rec["immediate-gw"] ?? "unknown";
        const distance = rec.distance;
        const active = rec.active === true || rec.active === "true";
        const dynamic = rec.dynamic === true || rec.dynamic === "true";

        let line = `  ${dstAddress} via ${gateway}`;

        if (distance) {
          line += ` [${distance}]`;
        }

        if (active) {
          line += " ACTIVE";
        }

        if (dynamic) {
          line += " DYNAMIC";
        }

        lines.push(line);
      }

      return {
        content: lines.join("\n"),
        structuredContent: {
          routerId: context.routerId,
          routes: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_routes" });
    }
  },
};

// ---------------------------------------------------------------------------
// manage_route
// ---------------------------------------------------------------------------

const manageRouteInputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  action: z.enum(["add", "remove"])
    .describe("Action to perform: add or remove a route"),
  dstAddress: z.string()
    .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/, "Must be an IPv4 address or CIDR notation, e.g. 10.0.0.0/8 or 10.77.0.4")
    .transform((v) => (v.includes("/") ? v : `${v}/32`))
    .describe("Destination address in CIDR notation or plain IP (auto-converted to /32), e.g. 10.0.0.0/8 or 10.77.0.4"),
  gateway: z.string()
    .describe("Gateway IP address"),
  distance: z.number().int().min(1).max(255).default(1)
    .describe("Route distance/metric (1-255)"),
  comment: z.string().max(255).optional()
    .describe("Optional comment for the route"),
  routingTable: z.string().optional()
    .describe("Routing table name (default: main). Use for policy routing with separate tables."),
  disabled: z.boolean().default(false)
    .describe("Whether the route should be disabled"),
  dryRun: z.boolean().default(false)
    .describe("If true, validate and return planned changes without applying"),
}).strict();

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

async function findExisting(
  context: ToolContext,
  dstAddress: string,
  gateway: string,
  routingTable?: string,
): Promise<RouterOSRecord | undefined> {
  const filter: Record<string, string> = { "dst-address": dstAddress };
  if (routingTable) filter["routing-table"] = routingTable;
  const results = await context.routerClient.get<RouterOSRecord>("ip/route", { filter });
  return results.find((r) => {
    const rec = r as Record<string, string>;
    const gw = rec.gateway ?? rec["immediate-gw"];
    return gw === gateway;
  });
}

const manageRouteTool: ToolDefinition = {
  name: "manage_route",
  title: "Manage Static Route",
  description:
    "Add or remove a static route on a MikroTik router. Performs idempotency checks for add operations and supports dry-run mode for all actions.",
  inputSchema: manageRouteInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageRouteInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info(
      { routerId: context.routerId, action: parsed.action, dstAddress: parsed.dstAddress, gateway: parsed.gateway },
      "Managing route",
    );

    try {
      const existing = await findExisting(context, parsed.dstAddress, parsed.gateway, parsed.routingTable);

      // -----------------------------------------------------------------------
      // ADD
      // -----------------------------------------------------------------------
      if (parsed.action === "add") {
        if (existing) {
          const rec = existing as Record<string, unknown>;
          const existingDistance = rec.distance ?? "1";
          const existingDisabled = rec.disabled === "true" || rec.disabled === true;
          const sameDistance = existingDistance === String(parsed.distance);
          const sameDisabled = existingDisabled === parsed.disabled;

          if (sameDistance && sameDisabled) {
            return {
              content: `Route ${parsed.dstAddress} via ${parsed.gateway} already exists. No changes made.`,
              structuredContent: {
                action: "already_exists",
                route: existing,
              },
            };
          }

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "ROUTE_CONFLICT",
            message: `Route ${parsed.dstAddress} via ${parsed.gateway} already exists but with different configuration (distance=${existingDistance}, disabled=${existingDisabled}). Requested distance=${parsed.distance}, disabled=${parsed.disabled}.`,
            details: {
              existing: { distance: existingDistance, disabled: String(existingDisabled) },
              requested: { distance: String(parsed.distance), disabled: String(parsed.disabled) },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing route first, or use manage_route with action=remove before re-adding.",
              alternativeTools: ["manage_route with action=remove"],
            },
          });
        }

        // Dry run for add
        if (parsed.dryRun) {
          const diff = [
            { property: "dst-address", before: null, after: parsed.dstAddress },
            { property: "gateway", before: null, after: parsed.gateway },
            { property: "distance", before: null, after: String(parsed.distance) },
            { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
            ...(parsed.routingTable ? [{ property: "routing-table", before: null, after: parsed.routingTable }] : []),
            ...(comment ? [{ property: "comment", before: null, after: comment }] : []),
          ];

          return {
            content: `Dry run: Would add route ${parsed.dstAddress} via ${parsed.gateway}${parsed.routingTable ? ` (table: ${parsed.routingTable})` : ""}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        // Create
        const body: Record<string, string> = {
          "dst-address": parsed.dstAddress,
          gateway: parsed.gateway,
          distance: String(parsed.distance),
          disabled: parsed.disabled ? "true" : "false",
        };
        if (parsed.routingTable) body["routing-table"] = parsed.routingTable;
        if (comment) body.comment = comment;

        const created = await context.routerClient.create("ip/route", body);

        log.info({ dstAddress: parsed.dstAddress, gateway: parsed.gateway, id: created[".id"] }, "Route added");

        return {
          content: `Added route ${parsed.dstAddress} via ${parsed.gateway}.`,
          structuredContent: { action: "created", route: created },
        };
      }

      // -----------------------------------------------------------------------
      // REMOVE
      // -----------------------------------------------------------------------
      if (parsed.action === "remove") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "ROUTE_NOT_FOUND",
            message: `Route ${parsed.dstAddress} via ${parsed.gateway} not found.`,
            details: { dstAddress: parsed.dstAddress, gateway: parsed.gateway },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the route exists using list_routes.",
              alternativeTools: ["list_routes"],
            },
          });
        }

        const rec = existing as Record<string, string>;
        const id = rec[".id"];

        // Dry run for remove
        if (parsed.dryRun) {
          const diff = [
            { property: "dst-address", before: parsed.dstAddress, after: null },
            { property: "gateway", before: parsed.gateway, after: null },
          ];

          return {
            content: `Dry run: Would remove route ${parsed.dstAddress} via ${parsed.gateway}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.remove("ip/route", id);

        log.info({ dstAddress: parsed.dstAddress, gateway: parsed.gateway, id }, "Route removed");

        return {
          content: `Removed route ${parsed.dstAddress} via ${parsed.gateway}.`,
          structuredContent: { action: "removed", id, dstAddress: parsed.dstAddress, gateway: parsed.gateway },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, remove.",
        },
      });
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_route" });
    }
  },
};

export const routeTools: ToolDefinition[] = [listRoutesTool, manageRouteTool];

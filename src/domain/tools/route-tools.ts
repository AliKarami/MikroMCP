// ---------------------------------------------------------------------------
// MikroMCP - Static route management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue, normalizeWireValue, sameValue } from "../../adapter/response-parser.js";
import { limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { paginate, listContent, compactFields } from "./pagination.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { isIP } from "node:net";
import {
  canonicalIpv6,
  cidrFamily,
  ipCidrSchema,
  normalizeIpv6Cidr,
  parseIpv6Cidr,
} from "./cidr.js";

const log = createLogger("route-tools");

const family = z
  .enum(["ip", "ipv6"])
  .default("ip")
  .describe("Address family: ip (IPv4, /ip/route) or ipv6 (/ipv6/route)");

type Family = "ip" | "ipv6";

function routePath(f: Family): string {
  return f === "ipv6" ? "ipv6/route" : "ip/route";
}

// ---------------------------------------------------------------------------
// list_routes
// ---------------------------------------------------------------------------

const listRoutesInputSchema = z
  .object({
    routerId,
    family,
    activeOnly: z.boolean().default(false).describe("Return only active routes"),
    staticOnly: z.boolean().default(false).describe("Return only non-dynamic routes"),
    limit,
    offset,
  })
  .strict();

const listRoutesTool: ToolDefinition = {
  name: "list_routes",
  title: "List Static Routes",
  description:
    "List routes on a MikroTik router (IPv4 by default, IPv6 with family=ipv6) with optional filtering by active status and dynamic status. Supports pagination.",
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
        family: parsed.family,
        activeOnly: parsed.activeOnly,
        staticOnly: parsed.staticOnly,
      },
      "Listing routes",
    );

    try {
      let routes = await context.routerClient.get<RouterOSRecord>(routePath(parsed.family), {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.activeOnly) {
        routes = routes.filter((route) => {
          const rec = route as Record<string, unknown>;
          return isTrue(rec.active);
        });
      }

      if (parsed.staticOnly) {
        routes = routes.filter((route) => {
          const rec = route as Record<string, unknown>;
          return !isTrue(rec.dynamic);
        });
      }

      const { items: paginated, total, hasMore } = paginate(routes, parsed.offset, parsed.limit);

      return {
        content: listContent(
          parsed.family === "ipv6" ? "IPv6 routes" : "Routes",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (r) =>
            compactFields(r, [
              "dst-address",
              "gateway",
              "distance",
              "routing-table",
              "active",
              "disabled",
            ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          family: parsed.family,
          routes: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_routes");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_route
// ---------------------------------------------------------------------------

const manageRouteInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform: add or remove a route"),
    family,
    dstAddress: ipCidrSchema.describe(
      "Destination in CIDR notation, or a plain address (auto-converted to /32 or /128), e.g. 10.0.0.0/8 or 2001:db8::/32. Must match family.",
    ),
    gateway: z
      .string()
      .min(1)
      .describe(
        "Gateway address or interface. For ipv6: a global address, a link-local address with its interface (fe80::1%ether1), or an interface name",
      ),
    distance: z.number().int().min(1).max(255).default(1).describe("Route distance/metric (1-255)"),
    comment: z.string().max(255).optional().describe("Optional comment for the route"),
    routingTable: z
      .string()
      .optional()
      .describe("Routing table name (default: main). Use for policy routing with separate tables."),
    disabled: z.boolean().default(false).describe("Whether the route should be disabled"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("If true, validate and return planned changes without applying"),
  })
  .strict();

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

function routeValidationError(code: string, message: string, suggestedAction: string) {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code,
    message,
    recoverability: { retryable: false, suggestedAction },
  });
}

/** An IPv6 gateway's text with its address part canonical; anything else unchanged. */
function canonicalIpv6Gateway(value: unknown): string {
  const text = normalizeWireValue(value);
  const zoneIdx = text.indexOf("%");
  const addr = zoneIdx === -1 ? text : text.slice(0, zoneIdx);
  const canonical = canonicalIpv6(addr);
  if (canonical === undefined) return text;
  return zoneIdx === -1 ? canonical : `${canonical}${text.slice(zoneIdx)}`;
}

/**
 * Check a gateway against the route's family. IPv4 gateways pass through as
 * before; an IPv6 gateway comes back with its address in canonical form so the
 * idempotency lookup matches what RouterOS prints.
 */
function validateGateway(gateway: string, f: Family): string {
  const zoneIdx = gateway.indexOf("%");
  const addr = zoneIdx === -1 ? gateway : gateway.slice(0, zoneIdx);
  const zone = zoneIdx === -1 ? undefined : gateway.slice(zoneIdx + 1);

  if (f === "ip") {
    if (isIP(addr) === 6) {
      throw routeValidationError(
        "ROUTE_FAMILY_MISMATCH",
        `Gateway ${gateway} is an IPv6 address, but family is ip.`,
        "Pass family: ipv6 for an IPv6 route.",
      );
    }
    return gateway;
  }

  if (isIP(addr) === 4) {
    throw routeValidationError(
      "ROUTE_FAMILY_MISMATCH",
      `Gateway ${gateway} is an IPv4 address, but family is ipv6.`,
      "Use an IPv6 gateway or interface name, or family: ip for an IPv4 route.",
    );
  }
  if (!addr.includes(":")) {
    if (zone !== undefined) {
      throw routeValidationError(
        "ROUTE_INVALID_GATEWAY",
        `Gateway ${gateway} is not an IPv6 address with an interface (address%interface).`,
        "Use an address such as fe80::1%ether1, a global IPv6 address, or an interface name.",
      );
    }
    return gateway;
  }

  const canonical = canonicalIpv6(addr);
  if (canonical === undefined || zone === "" || zone?.includes("%")) {
    throw routeValidationError(
      "ROUTE_INVALID_GATEWAY",
      `Gateway ${gateway} is not a valid IPv6 address.`,
      "Use a global IPv6 address, a link-local address with its interface (fe80::1%ether1), or an interface name.",
    );
  }
  // fe80::/10: a link-local next hop is only meaningful on one interface.
  const linkLocal = parseIpv6Cidr(canonical, 128).value >> 118n === 0x3fan;
  if (linkLocal && zone === undefined) {
    throw routeValidationError(
      "ROUTE_LINK_LOCAL_GATEWAY_NEEDS_INTERFACE",
      `Link-local gateway ${gateway} needs the interface it is reached on.`,
      `Append the interface, e.g. ${canonical}%ether1.`,
    );
  }
  return zone === undefined ? canonical : `${canonical}%${zone}`;
}

async function findExisting(
  context: ToolContext,
  f: Family,
  dstAddress: string,
  gateway: string,
  routingTable?: string,
): Promise<RouterOSRecord | undefined> {
  const filter: Record<string, string> = { "dst-address": dstAddress };
  if (routingTable) filter["routing-table"] = routingTable;
  const results = await context.routerClient.get<RouterOSRecord>(routePath(f), { filter });
  return results.find((r) => {
    const rec = r as Record<string, unknown>;
    const gw = rec.gateway ?? rec["immediate-gw"];
    if (f === "ip") return gw === gateway;
    return (
      normalizeIpv6Cidr(rec["dst-address"]) === dstAddress && canonicalIpv6Gateway(gw) === gateway
    );
  });
}

const manageRouteTool: ToolDefinition = {
  name: "manage_route",
  title: "Manage Static Route",
  description:
    "Add or remove a static route on a MikroTik router, IPv4 by default or IPv6 with family=ipv6 (link-local gateways as fe80::1%ether1). Performs idempotency checks for add operations and supports dry-run mode for all actions.",
  inputSchema: manageRouteInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: (params) => [routePath(params.family === "ipv6" ? "ipv6" : "ip")],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageRouteInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);
    const path = routePath(parsed.family);

    log.info(
      {
        routerId: context.routerId,
        family: parsed.family,
        action: parsed.action,
        dstAddress: parsed.dstAddress,
        gateway: parsed.gateway,
      },
      "Managing route",
    );

    try {
      if ((cidrFamily(parsed.dstAddress) === 6) !== (parsed.family === "ipv6")) {
        throw routeValidationError(
          "ROUTE_FAMILY_MISMATCH",
          `Destination ${parsed.dstAddress} is ${cidrFamily(parsed.dstAddress) === 6 ? "IPv6" : "IPv4"}, but family is ${parsed.family}.`,
          `Pass family: ${cidrFamily(parsed.dstAddress) === 6 ? "ipv6" : "ip"} for this destination.`,
        );
      }
      const gateway = validateGateway(parsed.gateway, parsed.family);

      const existing = await findExisting(
        context,
        parsed.family,
        parsed.dstAddress,
        gateway,
        parsed.routingTable,
      );

      // -----------------------------------------------------------------------
      // ADD
      // -----------------------------------------------------------------------
      if (parsed.action === "add") {
        if (existing) {
          const rec = existing as Record<string, unknown>;
          const existingDistance = String(rec.distance ?? "1");
          const existingDisabled = isTrue(rec.disabled);
          const sameDistance = sameValue(rec.distance ?? 1, parsed.distance);
          const sameDisabled = existingDisabled === parsed.disabled;

          if (sameDistance && sameDisabled) {
            return {
              content: `Route ${parsed.dstAddress} via ${gateway} already exists. No changes made.`,
              structuredContent: {
                action: "already_exists",
                route: existing,
              },
            };
          }

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "ROUTE_CONFLICT",
            message: `Route ${parsed.dstAddress} via ${gateway} already exists but with different configuration (distance=${existingDistance}, disabled=${existingDisabled}). Requested distance=${parsed.distance}, disabled=${parsed.disabled}.`,
            details: {
              existing: { distance: existingDistance, disabled: String(existingDisabled) },
              requested: { distance: String(parsed.distance), disabled: String(parsed.disabled) },
            },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Remove the existing route first, or use manage_route with action=remove before re-adding.",
              alternativeTools: ["manage_route with action=remove"],
            },
          });
        }

        // Dry run for add
        if (parsed.dryRun) {
          const diff = [
            { property: "dst-address", before: null, after: parsed.dstAddress },
            { property: "gateway", before: null, after: gateway },
            { property: "distance", before: null, after: String(parsed.distance) },
            { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
            ...(parsed.routingTable
              ? [{ property: "routing-table", before: null, after: parsed.routingTable }]
              : []),
            ...(comment ? [{ property: "comment", before: null, after: comment }] : []),
          ];

          return {
            content: `Dry run: Would add route ${parsed.dstAddress} via ${gateway}${parsed.routingTable ? ` (table: ${parsed.routingTable})` : ""}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        // Create
        const body: Record<string, string> = {
          "dst-address": parsed.dstAddress,
          gateway,
          distance: String(parsed.distance),
          disabled: parsed.disabled ? "true" : "false",
        };
        if (parsed.routingTable) body["routing-table"] = parsed.routingTable;
        if (comment) body.comment = comment;

        const created = await context.routerClient.create(path, body);

        log.info({ dstAddress: parsed.dstAddress, gateway, id: created[".id"] }, "Route added");

        return {
          content: `Added route ${parsed.dstAddress} via ${gateway}.`,
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
            message: `Route ${parsed.dstAddress} via ${gateway} not found.`,
            details: { dstAddress: parsed.dstAddress, gateway },
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
            { property: "gateway", before: gateway, after: null },
          ];

          return {
            content: `Dry run: Would remove route ${parsed.dstAddress} via ${gateway}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.remove(path, id);

        log.info({ dstAddress: parsed.dstAddress, gateway, id }, "Route removed");

        return {
          content: `Removed route ${parsed.dstAddress} via ${gateway}.`,
          structuredContent: {
            action: "removed",
            id,
            dstAddress: parsed.dstAddress,
            gateway,
          },
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
      throw toolError(err, context, "manage_route");
    }
  },
};

export const routeTools: ToolDefinition[] = [listRoutesTool, manageRouteTool];

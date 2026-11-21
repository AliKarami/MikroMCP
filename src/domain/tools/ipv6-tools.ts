// ---------------------------------------------------------------------------
// MikroMCP - IPv6 address, neighbor and DHCPv6 client tools
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
import {
  ipv6CidrSchema,
  ipv6HostBits,
  ipv6NetworkBits,
  parseIpv6Cidr,
  type Ipv6Cidr,
} from "./cidr.js";

const log = createLogger("ipv6-tools");

// ---------------------------------------------------------------------------
// list_ipv6_addresses
// ---------------------------------------------------------------------------

const listIpv6AddressesInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Only addresses on this interface"),
    disabled: z
      .enum(["true", "false", "all"])
      .default("all")
      .describe("Filter by disabled state: true, false, or all"),
    limit,
    offset,
  })
  .strict();

const listIpv6AddressesTool: ToolDefinition = {
  name: "list_ipv6_addresses",
  title: "List IPv6 Addresses",
  description:
    "List IPv6 addresses on a MikroTik router, including dynamic ones (link-local, SLAAC, DHCPv6). Shows EUI-64, router-advertisement and DHCPv6-PD pool settings. Supports filtering by interface and disabled state, with pagination.",
  inputSchema: listIpv6AddressesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpv6AddressesInputSchema.parse(params);
    log.info({ routerId: context.routerId, interface: parsed.interface }, "Listing IPv6 addresses");

    try {
      let addresses = await context.routerClient.get<RouterOSRecord>(
        "ipv6/address",
        parsed.interface !== undefined ? { filter: { interface: parsed.interface } } : {},
      );

      if (parsed.disabled !== "all") {
        const wantDisabled = parsed.disabled === "true";
        addresses = addresses.filter((a) => isTrue(a.disabled) === wantDisabled);
      }

      const { items, total, hasMore } = paginate(addresses, parsed.offset, parsed.limit);

      return {
        content: listContent("IPv6 addresses", context.routerId, items, total, parsed.offset, (a) =>
          compactFields(a, [
            "address",
            "interface",
            "eui-64",
            "advertise",
            "from-pool",
            "dynamic",
            "invalid",
            "disabled",
            "comment",
          ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          addresses: items,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_ipv6_addresses");
    }
  },
};

// ---------------------------------------------------------------------------
// manage_ipv6_address
// ---------------------------------------------------------------------------

const manageIpv6AddressInputSchema = z
  .object({
    routerId,
    action: z
      .enum(["add", "update", "remove"])
      .describe("Action to perform: add, update, or remove an IPv6 address"),
    address: ipv6CidrSchema.describe(
      "IPv6 address with prefix length, e.g. 2001:db8::1/64. With eui64, a prefix such as 2001:db8:1::/64 (the interface ID is generated). With fromPool, the interface-ID suffix such as ::1/64 (the prefix comes from the pool).",
    ),
    interface: z.string().min(1).describe("Interface the address is assigned to"),
    eui64: z
      .boolean()
      .default(false)
      .describe(
        "Generate the last 64 bits from the interface MAC (EUI-64); the prefix length must be 64 or shorter",
      ),
    fromPool: z
      .string()
      .min(1)
      .optional()
      .describe(
        "IPv6 pool (e.g. one filled by DHCPv6 prefix delegation) that supplies the prefix; address then gives only the suffix",
      ),
    advertise: z
      .boolean()
      .optional()
      .describe(
        "Advertise this prefix in router advertisements (SLAAC); omit to keep RouterOS's default",
      ),
    noDad: z
      .boolean()
      .optional()
      .describe("Skip duplicate address detection; omit to keep RouterOS's default (DAD on)"),
    comment: z.string().max(255).optional().describe("Optional comment for the address entry"),
    disabled: z.boolean().default(false).describe("Whether the address should be disabled"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("If true, validate and return planned changes without applying"),
  })
  .strict();

type ManageIpv6AddressParams = z.infer<typeof manageIpv6AddressInputSchema>;

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

function recordCidr(record: Record<string, unknown>): Ipv6Cidr | undefined {
  if (typeof record.address !== "string") return undefined;
  try {
    return parseIpv6Cidr(record.address);
  } catch {
    return undefined;
  }
}

function recordPool(record: Record<string, unknown>): string {
  return normalizeWireValue(record["from-pool"]);
}

/**
 * Whether a record is the address a call names, ignoring the interface. A plain
 * address matches by its full value, so an EUI-64 or pool-built address read
 * back from list_ipv6_addresses can be updated or removed as printed. An eui64
 * or fromPool request names an address the router derives, so it matches by
 * the part the caller supplied: the network bits for EUI-64, the suffix bits
 * for a pool address.
 */
function matchesAddress(
  record: Record<string, unknown>,
  requested: Ipv6Cidr,
  parsed: ManageIpv6AddressParams,
): boolean {
  const cidr = recordCidr(record);
  if (!cidr || cidr.prefix !== requested.prefix) return false;

  if (parsed.fromPool !== undefined) {
    if (recordPool(record) !== parsed.fromPool) return false;
    if (parsed.eui64) return isTrue(record["eui-64"]);
    return !isTrue(record["eui-64"]) && ipv6HostBits(cidr) === ipv6HostBits(requested);
  }
  if (parsed.eui64) {
    return (
      isTrue(record["eui-64"]) &&
      recordPool(record) === "" &&
      ipv6NetworkBits(cidr) === ipv6NetworkBits(requested)
    );
  }
  return cidr.address === requested.address;
}

function validateAddressForm(requested: Ipv6Cidr, parsed: ManageIpv6AddressParams): void {
  if (parsed.eui64 && requested.prefix > 64) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "IPV6_EUI64_PREFIX_TOO_LONG",
      message: `EUI-64 fills the last 64 bits of the address, so the prefix length must be 64 or shorter (got /${requested.prefix}).`,
      details: { address: parsed.address },
      recoverability: {
        retryable: false,
        suggestedAction: "Pass a /64 prefix such as 2001:db8:1::/64 with eui64, or drop eui64.",
      },
    });
  }
  if (parsed.fromPool !== undefined && ipv6NetworkBits(requested) !== 0n) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "IPV6_POOL_ADDRESS_HAS_PREFIX",
      message: `With fromPool the prefix comes from pool "${parsed.fromPool}", so address must give only the suffix with its first /${requested.prefix} bits zero (got ${parsed.address}).`,
      details: { address: parsed.address, fromPool: parsed.fromPool },
      recoverability: {
        retryable: false,
        suggestedAction: `Pass the suffix only, e.g. ::1/${requested.prefix}, or drop fromPool to assign ${parsed.address} directly.`,
      },
    });
  }
}

function dynamicRefusal(record: Record<string, unknown>, action: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "IPV6_ADDRESS_DYNAMIC",
    message: `IPv6 address ${String(record.address)} on ${String(record.interface)} is dynamic (link-local, SLAAC or DHCPv6) and cannot be ${action}. RouterOS manages it.`,
    details: { address: record.address, interface: record.interface },
    recoverability: {
      retryable: false,
      suggestedAction:
        "Change its source instead: the DHCPv6 client (list_dhcpv6_clients), router advertisements accepted by ipv6/settings, or the interface's link-local address.",
      alternativeTools: ["list_dhcpv6_clients", "list_ipv6_addresses"],
    },
  });
}

function describeTarget(parsed: ManageIpv6AddressParams): string {
  const parts = [parsed.address];
  if (parsed.eui64) parts.push("(EUI-64)");
  if (parsed.fromPool !== undefined) parts.push(`from pool ${parsed.fromPool}`);
  return `${parts.join(" ")} on ${parsed.interface}`;
}

type Diff = Array<{ property: string; before: string | null; after: string | null }>;

function boolText(value: boolean): string {
  return value ? "true" : "false";
}

function wireText(value: unknown): string | null {
  return value === undefined ? null : String(value);
}

const manageIpv6AddressTool: ToolDefinition = {
  name: "manage_ipv6_address",
  title: "Manage IPv6 Address",
  description:
    "Add, update, or remove a static IPv6 address on a MikroTik router interface, including EUI-64 and DHCPv6-PD pool (fromPool) addresses. Idempotent by address and interface: an identical add returns already_exists, an update with nothing to change returns no_change. Addresses are compared in canonical form. Dynamic addresses are refused. Supports dry-run for all actions.",
  inputSchema: manageIpv6AddressInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ipv6/address"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageIpv6AddressInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);
    const requested = parseIpv6Cidr(parsed.address);
    const target = describeTarget(parsed);

    log.info(
      {
        routerId: context.routerId,
        action: parsed.action,
        address: parsed.address,
        interface: parsed.interface,
      },
      "Managing IPv6 address",
    );

    try {
      validateAddressForm(requested, parsed);

      const records = (await context.routerClient.get<RouterOSRecord>("ipv6/address")) as Record<
        string,
        unknown
      >[];
      const matches = records.filter((r) => matchesAddress(r, requested, parsed));
      const existing = matches.find((r) => sameValue(r.interface, parsed.interface));
      // A derived (EUI-64 or pool) address is per interface, so only a plain
      // address can collide with one on another interface.
      const elsewhere =
        parsed.eui64 || parsed.fromPool !== undefined
          ? []
          : matches.filter((r) => !sameValue(r.interface, parsed.interface));

      if (parsed.action === "add") {
        if (existing) {
          if (isTrue(existing.dynamic)) {
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "IPV6_ADDRESS_DYNAMIC",
              message: `IPv6 address ${String(existing.address)} already exists on ${parsed.interface} as a dynamic address (link-local, SLAAC or DHCPv6). A static copy cannot be added.`,
              details: { existing },
              recoverability: {
                retryable: false,
                suggestedAction:
                  "Leave the dynamic address in place, or stop its source (DHCPv6 client or accepted router advertisements) first.",
                alternativeTools: ["list_ipv6_addresses", "list_dhcpv6_clients"],
              },
            });
          }

          const mismatches: Diff = [];
          const check = (property: string, same: boolean, before: unknown, after: string) => {
            if (!same) mismatches.push({ property, before: wireText(before), after });
          };
          check(
            "eui-64",
            isTrue(existing["eui-64"]) === parsed.eui64,
            existing["eui-64"],
            boolText(parsed.eui64),
          );
          check(
            "from-pool",
            recordPool(existing) === (parsed.fromPool ?? ""),
            existing["from-pool"],
            parsed.fromPool ?? "",
          );
          check(
            "disabled",
            isTrue(existing.disabled) === parsed.disabled,
            existing.disabled,
            boolText(parsed.disabled),
          );
          check(
            "no-dad",
            isTrue(existing["no-dad"]) === (parsed.noDad ?? false),
            existing["no-dad"],
            boolText(parsed.noDad ?? false),
          );
          if (parsed.advertise !== undefined) {
            check(
              "advertise",
              isTrue(existing.advertise) === parsed.advertise,
              existing.advertise,
              boolText(parsed.advertise),
            );
          }
          check(
            "comment",
            normalizeWireValue(existing.comment) === normalizeWireValue(comment),
            existing.comment,
            comment ?? "",
          );

          if (mismatches.length === 0) {
            return {
              content: `IPv6 address ${target} already exists with matching configuration. No changes made.`,
              structuredContent: { action: "already_exists", address: existing },
            };
          }

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "IPV6_ADDRESS_CONFLICT",
            message: `IPv6 address ${target} already exists with different configuration: ${mismatches.map((m) => `${m.property} is ${m.before ?? "unset"}, requested ${m.after}`).join("; ")}.`,
            details: { existing, differences: mismatches },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Use action=update to change advertise, noDad, comment or disabled; remove the address first to change eui64 or fromPool.",
              alternativeTools: ["manage_ipv6_address with action=update"],
            },
          });
        }

        if (elsewhere.length > 0) {
          const other = elsewhere[0];
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "IPV6_ADDRESS_CONFLICT",
            message: `IPv6 address ${parsed.address} is already assigned to interface ${String(other.interface)}; it cannot also be added on ${parsed.interface}.`,
            details: { existing: other, requested: { interface: parsed.interface } },
            recoverability: {
              retryable: false,
              suggestedAction: `Remove it from ${String(other.interface)} first, or pick another address.`,
              alternativeTools: ["manage_ipv6_address with action=remove"],
            },
          });
        }

        const body: Record<string, string> = {
          address: parsed.address,
          interface: parsed.interface,
          disabled: boolText(parsed.disabled),
        };
        if (parsed.eui64) body["eui-64"] = "true";
        if (parsed.fromPool !== undefined) body["from-pool"] = parsed.fromPool;
        if (parsed.advertise !== undefined) body.advertise = boolText(parsed.advertise);
        if (parsed.noDad !== undefined) body["no-dad"] = boolText(parsed.noDad);
        if (comment) body.comment = comment;

        if (parsed.dryRun) {
          const diff: Diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add IPv6 address ${target}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create("ipv6/address", body);
        log.info({ address: parsed.address, id: created[".id"] }, "IPv6 address added");

        return {
          content: `Added IPv6 address ${target}.`,
          structuredContent: { action: "created", address: created },
        };
      }

      if (!existing) {
        const where =
          elsewhere.length > 0
            ? ` It is assigned to ${elsewhere.map((r) => String(r.interface)).join(", ")}.`
            : "";
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "IPV6_ADDRESS_NOT_FOUND",
          message: `IPv6 address ${target} not found.${where}${parsed.action === "remove" ? " Cannot remove." : ""}`,
          details: {
            address: parsed.address,
            interface: parsed.interface,
            ...(elsewhere.length > 0 ? { foundOn: elsewhere.map((r) => r.interface) } : {}),
          },
          recoverability: {
            retryable: false,
            suggestedAction:
              parsed.action === "update"
                ? "Verify the address and interface with list_ipv6_addresses, or use action=add to create it."
                : "Verify the address and interface with list_ipv6_addresses.",
            alternativeTools: ["list_ipv6_addresses"],
          },
        });
      }

      if (isTrue(existing.dynamic)) {
        throw dynamicRefusal(existing, parsed.action === "update" ? "updated" : "removed");
      }

      const id = String(existing[".id"]);

      if (parsed.action === "update") {
        const changes: Record<string, string> = {};
        const diff: Diff = [];
        const change = (property: string, same: boolean, after: string) => {
          if (same) return;
          changes[property] = after;
          diff.push({ property, before: wireText(existing[property]), after });
        };

        change(
          "disabled",
          isTrue(existing.disabled) === parsed.disabled,
          boolText(parsed.disabled),
        );
        if (parsed.advertise !== undefined) {
          change(
            "advertise",
            isTrue(existing.advertise) === parsed.advertise,
            boolText(parsed.advertise),
          );
        }
        if (parsed.noDad !== undefined) {
          change("no-dad", isTrue(existing["no-dad"]) === parsed.noDad, boolText(parsed.noDad));
        }
        if (comment !== undefined) {
          change(
            "comment",
            normalizeWireValue(existing.comment) === normalizeWireValue(comment),
            comment,
          );
        }

        if (diff.length === 0) {
          return {
            content: `IPv6 address ${target} already has the requested configuration. No changes made.`,
            structuredContent: { action: "no_change", address: existing },
          };
        }

        const summary = diff.map((d) => `${d.property}: ${d.before} -> ${d.after}`).join(", ");

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update IPv6 address ${target}: ${summary}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update("ipv6/address", id, changes);
        log.info({ address: parsed.address, id, changes }, "IPv6 address updated");

        return {
          content: `Updated IPv6 address ${target}: ${summary}.`,
          structuredContent: { action: "updated", id, changes: diff },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove IPv6 address ${String(existing.address)} from ${parsed.interface}.`,
          structuredContent: {
            action: "dry_run",
            diff: [
              { property: "address", before: String(existing.address), after: null },
              { property: "interface", before: parsed.interface, after: null },
            ],
          },
        };
      }

      await context.routerClient.remove("ipv6/address", id);
      log.info({ address: existing.address, id }, "IPv6 address removed");

      return {
        content: `Removed IPv6 address ${String(existing.address)} from ${parsed.interface}.`,
        structuredContent: {
          action: "removed",
          id,
          address: existing.address,
          interface: parsed.interface,
        },
      };
    } catch (err) {
      throw toolError(err, context, "manage_ipv6_address");
    }
  },
};

// ---------------------------------------------------------------------------
// list_ipv6_neighbors
// ---------------------------------------------------------------------------

const listIpv6NeighborsInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Only neighbors on this interface"),
    status: z
      .string()
      .min(1)
      .optional()
      .describe("Only neighbors in this state, e.g. reachable, stale, delay, probe, failed, noarp"),
    limit,
    offset,
  })
  .strict();

const listIpv6NeighborsTool: ToolDefinition = {
  name: "list_ipv6_neighbors",
  title: "List IPv6 Neighbors",
  description:
    "List the IPv6 neighbor table (the IPv6 counterpart of ARP) on a MikroTik router: address, MAC, interface, reachability state, and whether the neighbor is a router. Supports filtering by interface and status, with pagination.",
  inputSchema: listIpv6NeighborsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpv6NeighborsInputSchema.parse(params);
    log.info({ routerId: context.routerId, interface: parsed.interface }, "Listing IPv6 neighbors");

    try {
      let neighbors = await context.routerClient.get<RouterOSRecord>(
        "ipv6/neighbor",
        parsed.interface !== undefined ? { filter: { interface: parsed.interface } } : {},
      );

      if (parsed.status !== undefined) {
        neighbors = neighbors.filter((n) => sameValue(n.status, parsed.status));
      }

      const { items, total, hasMore } = paginate(neighbors, parsed.offset, parsed.limit);

      return {
        content: listContent("IPv6 neighbors", context.routerId, items, total, parsed.offset, (n) =>
          compactFields(n, ["address", "mac-address", "interface", "status", "router"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          neighbors: items,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_ipv6_neighbors");
    }
  },
};

// ---------------------------------------------------------------------------
// list_dhcpv6_clients
// ---------------------------------------------------------------------------

const listDhcpv6ClientsInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Only the client on this interface"),
    status: z
      .string()
      .min(1)
      .optional()
      .describe("Only clients in this state, e.g. bound, searching, requesting, stopped"),
    limit,
    offset,
  })
  .strict();

const listDhcpv6ClientsTool: ToolDefinition = {
  name: "list_dhcpv6_clients",
  title: "List DHCPv6 Clients",
  description:
    "List DHCPv6 clients on a MikroTik router: what each requests (address and/or prefix), its status, the delegated prefix and the pool it fills, and whether it adds a default route or uses the peer's DNS. Supports filtering by interface and status, with pagination.",
  inputSchema: listDhcpv6ClientsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listDhcpv6ClientsInputSchema.parse(params);
    log.info({ routerId: context.routerId, interface: parsed.interface }, "Listing DHCPv6 clients");

    try {
      let clients = (await context.routerClient.get<RouterOSRecord>("ipv6/dhcp-client")) as Record<
        string,
        unknown
      >[];

      if (parsed.interface !== undefined) {
        clients = clients.filter((c) => sameValue(c.interface, parsed.interface));
      }
      if (parsed.status !== undefined) {
        clients = clients.filter((c) => sameValue(c.status, parsed.status));
      }

      const { items, total, hasMore } = paginate(clients, parsed.offset, parsed.limit);

      return {
        content: listContent("DHCPv6 clients", context.routerId, items, total, parsed.offset, (c) =>
          compactFields(c, [
            "interface",
            "status",
            "request",
            "pool-name",
            "pool-prefix-length",
            "prefix",
            "address",
            "add-default-route",
            "use-peer-dns",
            "disabled",
            "comment",
          ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          clients: items,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_dhcpv6_clients");
    }
  },
};

export const ipv6Tools: ToolDefinition[] = [
  listIpv6AddressesTool,
  manageIpv6AddressTool,
  listIpv6NeighborsTool,
  listDhcpv6ClientsTool,
];

import { z } from "zod";
import { isIP } from "node:net";
import { sameValue } from "../../adapter/response-parser.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("wireguard-tools");

const listWgInputSchema = z
  .object({
    routerId,
    limit,
    offset,
  })
  .strict();

const listWgTool: ToolDefinition = {
  name: "list_wireguard_interfaces",
  title: "List WireGuard Interfaces",
  description: "List WireGuard interfaces and their status on a MikroTik router.",
  inputSchema: listWgInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listWgInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing WireGuard interfaces");
    try {
      const interfaces = await context.routerClient.get<RouterOSRecord>("interface/wireguard", {
        limit: undefined,
        offset: undefined,
      });
      const {
        items: paginated,
        total,
        hasMore,
      } = paginate(interfaces, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "WireGuard interfaces",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (i) => compactFields(i, ["name", "listen-port", "mtu", "running", "disabled", "comment"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          interfaces: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_wireguard_interfaces");
    }
  },
};

const listPeersInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Filter by WireGuard interface name"),
    limit,
    offset,
  })
  .strict();

const listPeersTool: ToolDefinition = {
  name: "list_wireguard_peers",
  title: "List WireGuard Peers",
  description: "List WireGuard peers with last handshake time and transfer statistics.",
  inputSchema: listPeersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listPeersInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, interface: parsed.interface },
      "Listing WireGuard peers",
    );
    try {
      const filter = parsed.interface ? { interface: parsed.interface } : undefined;
      const allPeers = await context.routerClient.get<RouterOSRecord>("interface/wireguard/peers", {
        filter,
      });

      const { items: peers, total, hasMore } = paginate(allPeers, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "WireGuard peers",
          context.routerId,
          peers,
          total,
          parsed.offset,
          (p) =>
            compactFields(p, [
              "interface",
              "public-key",
              "endpoint-address",
              "endpoint-port",
              "allowed-address",
              "disabled",
            ]),
        ),
        structuredContent: {
          routerId: context.routerId,
          peers,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_wireguard_peers");
    }
  },
};

function parsePeerEndpoint(endpoint: string): Record<string, string> | undefined {
  if (/\s/.test(endpoint) || endpoint.includes("%")) return undefined;
  if (isIP(endpoint) === 6) return { "endpoint-address": endpoint };
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(endpoint);
  const host = /^([^:]+)(?::(\d+))?$/.exec(endpoint);
  const match = ipv6 ?? host;
  if (!match) return undefined;

  const [, address, port] = match;
  if (ipv6) {
    if (isIP(address) !== 6) return undefined;
  } else if (isIP(address) !== 4) {
    const hostname = address.endsWith(".") ? address.slice(0, -1) : address;
    if (
      hostname.length > 253 ||
      /^[\d.]+$/.test(hostname) ||
      !hostname.split(".").every((label) => /^[a-z\d_](?:[a-z\d_-]{0,61}[a-z\d_])?$/i.test(label))
    ) {
      return undefined;
    }
  }
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return undefined;

  return {
    "endpoint-address": address,
    ...(port === undefined ? {} : { "endpoint-port": String(Number(port)) }),
  };
}

const peerEndpointSchema = z.string().transform((endpoint, ctx) => {
  const fields = parsePeerEndpoint(endpoint);
  if (fields) return fields;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      "Use IPv4:port, hostname:port or [IPv6]:port with port 1–65535, or an address without a port",
  });
  return z.NEVER;
});

function canonicalPeerAddress(value: unknown): string {
  const address = String(value ?? "");
  if (isIP(address) === 6) return new URL(`http://[${address}]/`).hostname;
  return address.toLowerCase().replace(/\.$/, "");
}

function canonicalAllowedAddresses(value: unknown): string {
  const addresses = String(value ?? "")
    .split(",")
    .map((item) => {
      const cidr = item.trim();
      const [address, prefix] = cidr.split("/");
      const family = isIP(address);
      if (!family || (prefix !== undefined && !/^\d+$/.test(prefix))) return cidr;
      const bits = family === 4 ? 32 : 128;
      const length = Number(prefix ?? bits);
      if (length > bits || cidr.split("/").length > 2) return cidr;
      return `${canonicalPeerAddress(address)}/${length}`;
    });
  return [...new Set(addresses)].sort().join(",");
}

const managePeerInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    interface: z.string().describe("WireGuard interface name (e.g. wg0)"),
    publicKey: z.string().min(1).describe("Peer public key in base64 format (44 characters)"),
    allowedAddress: z
      .string()
      .optional()
      .describe("Allowed IP address/CIDR for this peer (e.g. 10.0.0.2/32)"),
    endpoint: z
      .string()
      .optional()
      .describe(
        "Add only: IPv4:port, hostname:port or [IPv6]:port (port 1–65535); hostname labels may contain underscores. Address-only IPv4/hostname/IPv6 (bare or bracketed) leaves the RouterOS port default unchanged, which may not allow initiation. Ignored for remove; omit for a roaming peer.",
      ),
    comment: z.string().max(255).optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const managePeerTool: ToolDefinition = {
  name: "manage_wireguard_peer",
  title: "Manage WireGuard Peer",
  description:
    "Add or remove a WireGuard peer. Add returns already_exists when the public key and explicitly requested endpoint/allowed addresses match; different settings produce CONFLICT without changing the peer. Omitted settings are left unchanged.",
  inputSchema: managePeerInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/wireguard/peers"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = managePeerInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, interface: parsed.interface },
      "Managing WireGuard peer",
    );
    try {
      const endpointFields =
        parsed.action === "add" && parsed.endpoint !== undefined
          ? peerEndpointSchema.parse(parsed.endpoint)
          : {};
      const existing = await context.routerClient.get<RouterOSRecord>("interface/wireguard/peers", {
        filter: { interface: parsed.interface, "public-key": parsed.publicKey },
      });

      if (parsed.action === "add") {
        if (existing.length > 0) {
          const rec = existing[0];
          const requestedFields = {
            ...endpointFields,
            ...(parsed.allowedAddress === undefined
              ? {}
              : { "allowed-address": parsed.allowedAddress }),
          };
          const mismatched = Object.entries(requestedFields).filter(([property, desired]) => {
            if (property === "endpoint-address") {
              return canonicalPeerAddress(rec[property]) !== canonicalPeerAddress(desired);
            }
            if (property === "allowed-address") {
              return (
                canonicalAllowedAddresses(rec[property]) !== canonicalAllowedAddresses(desired)
              );
            }
            return !sameValue(rec[property], desired);
          });
          if (mismatched.length > 0) {
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "WIREGUARD_PEER_CONFLICT",
              message: `WireGuard peer already exists on "${parsed.interface}" with different requested settings.`,
              details: {
                existing: Object.fromEntries(
                  mismatched.map(([property]) => [property, rec[property]]),
                ),
                requested: Object.fromEntries(mismatched),
              },
              recoverability: {
                retryable: false,
                suggestedAction:
                  "Inspect the peer with list_wireguard_peers, then remove it before adding different settings.",
                alternativeTools: ["list_wireguard_peers", "manage_wireguard_peer"],
              },
            });
          }
          return {
            content: `WireGuard peer with this public key already exists on "${parsed.interface}". No changes made.`,
            structuredContent: { action: "already_exists", peer: existing[0] },
          };
        }
        if (parsed.dryRun) {
          const diff = [
            { property: "interface", before: null, after: parsed.interface },
            { property: "public-key", before: null, after: parsed.publicKey },
            ...(parsed.allowedAddress !== undefined
              ? [{ property: "allowed-address", before: null, after: parsed.allowedAddress }]
              : []),
            ...Object.entries(endpointFields).map(([property, after]) => ({
              property,
              before: null,
              after,
            })),
          ];
          return {
            content: `Dry run: Would add WireGuard peer on "${parsed.interface}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }
        const body: Record<string, string> = {
          interface: parsed.interface,
          "public-key": parsed.publicKey,
          ...endpointFields,
        };
        if (parsed.allowedAddress !== undefined) body["allowed-address"] = parsed.allowedAddress;
        if (parsed.comment) body.comment = parsed.comment.replace(/[\x00-\x1f\x7f]/g, "");

        const created = await context.routerClient.create("interface/wireguard/peers", body);
        log.info({ interface: parsed.interface, id: created[".id"] }, "WireGuard peer added");
        return {
          content: `Added WireGuard peer on "${parsed.interface}".`,
          structuredContent: { action: "created", peer: created },
        };
      }

      if (existing.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "WIREGUARD_PEER_NOT_FOUND",
          message: `WireGuard peer with this public key not found on interface "${parsed.interface}".`,
          details: { interface: parsed.interface, publicKey: parsed.publicKey },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the public key and interface with list_wireguard_peers.",
          },
        });
      }
      const rec = existing[0] as Record<string, string>;
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove WireGuard peer from "${parsed.interface}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "public-key", before: parsed.publicKey, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/wireguard/peers", rec[".id"]);
      log.info({ interface: parsed.interface }, "WireGuard peer removed");
      return {
        content: `Removed WireGuard peer from "${parsed.interface}".`,
        structuredContent: { action: "removed", interface: parsed.interface, id: rec[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_wireguard_peer");
    }
  },
};

const manageWgIfaceInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("Interface name — idempotency key (e.g. wg0)"),
    listenPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("UDP listen port (RouterOS picks one if omitted)"),
    mtu: z.number().int().min(1280).max(65535).default(1420).describe("MTU (default 1420)"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageWgIfaceTool: ToolDefinition = {
  name: "manage_wireguard_interface",
  title: "Manage WireGuard Interface",
  description:
    "Add, remove, enable, or disable a WireGuard interface. Idempotent by name. RouterOS generates the private key on create — it is never passed in. The public key is returned after creation.",
  inputSchema: manageWgIfaceInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/wireguard"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageWgIfaceInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing WireGuard interface",
    );
    try {
      const all = await context.routerClient.get<RouterOSRecord>("interface/wireguard", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find((i) => i.name === parsed.name);

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `WireGuard interface "${parsed.name}" already exists. No changes made.`,
            structuredContent: {
              action: "already_exists",
              name: parsed.name,
              publicKey: existing["public-key"] ?? null,
            },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create WireGuard interface "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: null, after: parsed.name }],
            },
          };
        }
        const body: Record<string, string> = { name: parsed.name, mtu: String(parsed.mtu) };
        if (parsed.listenPort !== undefined) body["listen-port"] = String(parsed.listenPort);
        if (parsed.comment) body.comment = parsed.comment;
        const created = (await context.routerClient.create("interface/wireguard", body)) as Record<
          string,
          string
        >;
        log.info({ name: parsed.name, id: created[".id"] }, "WireGuard interface created");
        return {
          content: `Created WireGuard interface "${parsed.name}". Public key: ${created["public-key"] ?? "unknown"}`,
          structuredContent: {
            action: "created",
            name: parsed.name,
            id: created[".id"],
            publicKey: created["public-key"] ?? null,
          },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `WireGuard interface "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove WireGuard interface "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("interface/wireguard", existing[".id"]);
        log.info({ name: parsed.name }, "WireGuard interface removed");
        return {
          content: `Removed WireGuard interface "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "WIREGUARD_IFACE_NOT_FOUND",
          message: `WireGuard interface "${parsed.name}" not found.`,
          recoverability: {
            retryable: false,
            suggestedAction: "Verify with list_wireguard_interfaces.",
            alternativeTools: ["list_wireguard_interfaces"],
          },
        });
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} WireGuard interface "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [
              {
                property: "disabled",
                before: existing.disabled,
                after: parsed.action === "disable" ? "true" : "false",
              },
            ],
          },
        };
      }
      await context.routerClient.update("interface/wireguard", existing[".id"], {
        disabled: parsed.action === "disable" ? "true" : "false",
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "WireGuard interface updated");
      return {
        content: `WireGuard interface "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_wireguard_interface");
    }
  },
};

export const wireguardTools: ToolDefinition[] = [
  listWgTool,
  listPeersTool,
  managePeerTool,
  manageWgIfaceTool,
];

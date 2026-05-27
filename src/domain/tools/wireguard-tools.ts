import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("wireguard-tools");

const listWgInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of interfaces to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
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
      const total = interfaces.length;
      const paginated = interfaces.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      const lines = [`WireGuard interfaces on ${context.routerId}: ${total} total`];
      for (const iface of paginated) {
        const rec = iface as Record<string, string>;
        const running = rec.running === "true" ? "UP" : "DOWN";
        lines.push(`  ${rec.name} [port=${rec["listen-port"] ?? "?"}] ${running}`);
      }

      return {
        content: lines.join("\n"),
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
      throw enrichError(err, { routerId: context.routerId, tool: "list_wireguard_interfaces" });
    }
  },
};

const listPeersInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    interface: z.string().optional().describe("Filter by WireGuard interface name"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of peers to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
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

      const total = allPeers.length;
      const peers = allPeers.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      const lines = [`WireGuard peers on ${context.routerId}: ${total} total`];
      for (const peer of peers) {
        const rec = peer as Record<string, string>;
        const key = rec["public-key"] ? rec["public-key"].slice(0, 8) + "…" : "unknown";
        lines.push(
          `  [${rec.interface ?? "?"}] ${key} last-handshake=${rec["last-handshake"] ?? "never"}`,
        );
      }

      return {
        content: lines.join("\n"),
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
      throw enrichError(err, { routerId: context.routerId, tool: "list_wireguard_peers" });
    }
  },
};

const managePeerInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    interface: z.string().describe("WireGuard interface name (e.g. wg0)"),
    publicKey: z.string().min(1).describe("Peer public key in base64 format (44 characters)"),
    allowedAddress: z
      .string()
      .optional()
      .describe("Allowed IP address/CIDR for this peer (e.g. 10.0.0.2/32)"),
    endpoint: z.string().optional().describe("Peer endpoint as IP:port (e.g. 1.2.3.4:51820)"),
    comment: z.string().max(255).optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const managePeerTool: ToolDefinition = {
  name: "manage_wireguard_peer",
  title: "Manage WireGuard Peer",
  description:
    "Add or remove a WireGuard peer. Idempotent by public key: add returns already_exists if a peer with the same public key already exists on the interface.",
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
      const existing = await context.routerClient.get<RouterOSRecord>("interface/wireguard/peers", {
        filter: { interface: parsed.interface, "public-key": parsed.publicKey },
      });

      if (parsed.action === "add") {
        if (existing.length > 0) {
          return {
            content: `WireGuard peer with this public key already exists on "${parsed.interface}". No changes made.`,
            structuredContent: { action: "already_exists", peer: existing[0] },
          };
        }
        if (parsed.dryRun) {
          const diff = [
            { property: "interface", before: null, after: parsed.interface },
            { property: "public-key", before: null, after: parsed.publicKey },
            ...(parsed.allowedAddress
              ? [{ property: "allowed-address", before: null, after: parsed.allowedAddress }]
              : []),
            ...(parsed.endpoint
              ? [{ property: "endpoint-address", before: null, after: parsed.endpoint }]
              : []),
          ];
          return {
            content: `Dry run: Would add WireGuard peer on "${parsed.interface}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }
        const body: Record<string, string> = {
          interface: parsed.interface,
          "public-key": parsed.publicKey,
        };
        if (parsed.allowedAddress) body["allowed-address"] = parsed.allowedAddress;
        if (parsed.endpoint) body["endpoint-address"] = parsed.endpoint;
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
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_wireguard_peer" });
    }
  },
};

const manageWgIfaceInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
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
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
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
    destructiveHint: false,
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
        const created = (await context.routerClient.create(
          "interface/wireguard",
          body,
        )) as Record<string, string>;
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
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_wireguard_interface" });
    }
  },
};

export const wireguardTools: ToolDefinition[] = [
  listWgTool,
  listPeersTool,
  managePeerTool,
  manageWgIfaceTool,
];

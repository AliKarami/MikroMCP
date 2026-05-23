import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ovpn-tools");

const OVPN_CLIENT_PATH = "interface/ovpn-client";
const OVPN_SERVER_PATH = "interface/ovpn-server/server";

// ─── list_ovpn_clients ────────────────────────────────────────────────────────

const listOvpnClientsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of clients to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  })
  .strict();

const listOvpnClientsTool: ToolDefinition = {
  name: "list_ovpn_clients",
  title: "List OpenVPN Clients",
  description:
    "List OpenVPN client interfaces on a MikroTik router. Shows name, remote server, and connection status.",
  inputSchema: listOvpnClientsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listOvpnClientsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing OpenVPN clients");
    try {
      const allClients = await context.routerClient.get<RouterOSRecord>(OVPN_CLIENT_PATH, {
        limit: undefined,
        offset: undefined,
      });

      const total = allClients.length;
      const clients = allClients.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      return {
        content: `OpenVPN clients on ${context.routerId}: ${total} total, showing ${clients.length} (offset ${parsed.offset})`,
        structuredContent: {
          routerId: context.routerId,
          clients,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_ovpn_clients" });
    }
  },
};

// ─── manage_ovpn_client ───────────────────────────────────────────────────────

const manageOvpnClientInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    name: z.string().describe("OpenVPN client interface name — idempotency key"),
    connectTo: z.string().optional().describe("Remote server address (required for add)"),
    port: z.number().int().min(1).max(65535).optional().describe("Remote port number"),
    mode: z.enum(["ip", "ethernet"]).optional().describe("Tunnel mode"),
    protocol: z.enum(["tcp-client", "udp"]).optional().describe("Transport protocol"),
    certificate: z.string().optional().describe("Client certificate name"),
    user: z.string().optional().describe("VPN username"),
    password: z.string().optional().describe("VPN password (never logged)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageOvpnClientTool: ToolDefinition = {
  name: "manage_ovpn_client",
  title: "Manage OpenVPN Client",
  description:
    "Add, update, or remove an OpenVPN client interface. Idempotent by name: add returns already_exists if same name+connectTo exists; throws CONFLICT if same name exists with different connectTo. Update builds a diff of changed fields and returns no_change when nothing differs. Password is always written when provided because RouterOS does not expose it in GET.",
  inputSchema: manageOvpnClientInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: [OVPN_CLIENT_PATH],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageOvpnClientInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing OpenVPN client");

    try {
      const allClients = await context.routerClient.get<RouterOSRecord>(OVPN_CLIENT_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allClients as Record<string, string>[]).find((c) => c.name === parsed.name);

      if (parsed.action === "add") {
        if (!parsed.connectTo) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "OVPN_CLIENT_CONNECT_TO_REQUIRED",
            message: "connectTo is required for action add.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the remote server address.",
              alternativeTools: [],
            },
          });
        }

        if (existing) {
          const sameConfig = existing["connect-to"] === parsed.connectTo;
          if (sameConfig) {
            return {
              content: `OpenVPN client "${parsed.name}" already exists with the same configuration. No changes made.`,
              structuredContent: { action: "already_exists", client: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "OVPN_CLIENT_CONFLICT",
            message: `OpenVPN client "${parsed.name}" already exists with a different configuration.`,
            details: {
              existing: { "connect-to": existing["connect-to"] },
              requested: { "connect-to": parsed.connectTo },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing client first or use action update.",
              alternativeTools: ["manage_ovpn_client"],
            },
          });
        }

        const diff: Array<{ property: string; before: null; after: string }> = [
          { property: "name", before: null, after: parsed.name },
          { property: "connect-to", before: null, after: parsed.connectTo },
        ];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create OpenVPN client "${parsed.name}" connecting to "${parsed.connectTo}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          "connect-to": parsed.connectTo,
        };
        if (parsed.port !== undefined) body.port = String(parsed.port);
        if (parsed.mode !== undefined) body.mode = parsed.mode;
        if (parsed.protocol !== undefined) body.protocol = parsed.protocol;
        if (parsed.certificate !== undefined) body.certificate = parsed.certificate;
        if (parsed.user !== undefined) body.user = parsed.user;
        if (parsed.password !== undefined) body.password = parsed.password;

        const created = await context.routerClient.create(OVPN_CLIENT_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "OpenVPN client created");
        return {
          content: `Created OpenVPN client "${parsed.name}" connecting to "${parsed.connectTo}".`,
          structuredContent: { action: "created", client: created },
        };
      }

      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "OVPN_CLIENT_NOT_FOUND",
            message: `OpenVPN client "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify with list_ovpn_clients.",
              alternativeTools: ["list_ovpn_clients"],
            },
          });
        }

        const updates: Record<string, string> = {};
        const diff: Array<{ property: string; before: string | null; after: string }> = [];

        if (parsed.connectTo !== undefined && existing["connect-to"] !== parsed.connectTo) {
          updates["connect-to"] = parsed.connectTo;
          diff.push({ property: "connect-to", before: existing["connect-to"] ?? null, after: parsed.connectTo });
        }
        if (parsed.port !== undefined && existing.port !== String(parsed.port)) {
          updates.port = String(parsed.port);
          diff.push({ property: "port", before: existing.port ?? null, after: String(parsed.port) });
        }
        if (parsed.mode !== undefined && existing.mode !== parsed.mode) {
          updates.mode = parsed.mode;
          diff.push({ property: "mode", before: existing.mode ?? null, after: parsed.mode });
        }
        if (parsed.protocol !== undefined && existing.protocol !== parsed.protocol) {
          updates.protocol = parsed.protocol;
          diff.push({ property: "protocol", before: existing.protocol ?? null, after: parsed.protocol });
        }
        if (parsed.certificate !== undefined && existing.certificate !== parsed.certificate) {
          updates.certificate = parsed.certificate;
          diff.push({ property: "certificate", before: existing.certificate ?? null, after: parsed.certificate });
        }
        if (parsed.user !== undefined && existing.user !== parsed.user) {
          updates.user = parsed.user;
          diff.push({ property: "user", before: existing.user ?? null, after: parsed.user });
        }

        // RouterOS does not expose password in GET — always write it when provided
        if (parsed.password !== undefined) {
          updates.password = parsed.password;
        }

        const hasUpdates = Object.keys(updates).length > 0;

        if (!hasUpdates) {
          return {
            content: `OpenVPN client "${parsed.name}" already matches the requested configuration. No changes made.`,
            structuredContent: { action: "no_change", client: existing },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update OpenVPN client "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(OVPN_CLIENT_PATH, existing[".id"], updates);
        log.info({ name: parsed.name }, "OpenVPN client updated");
        return {
          content: `Updated OpenVPN client "${parsed.name}".`,
          structuredContent: { action: "updated", name: parsed.name, diff },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `OpenVPN client "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove OpenVPN client "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }

      await context.routerClient.remove(OVPN_CLIENT_PATH, existing[".id"]);
      log.info({ name: parsed.name }, "OpenVPN client removed");
      return {
        content: `Removed OpenVPN client "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_ovpn_client" });
    }
  },
};

// ─── get_ovpn_server ──────────────────────────────────────────────────────────

const getOvpnServerInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
  })
  .strict();

function fetchOvpnServer(
  allRecords: RouterOSRecord[],
  routerId: string,
): Record<string, string> {
  if (allRecords.length === 0) {
    throw new MikroMCPError({
      category: ErrorCategory.NOT_FOUND,
      code: "OVPN_SERVER_NOT_FOUND",
      message: "OpenVPN server not found. The OpenVPN package may not be installed on this router.",
      details: { routerId },
      recoverability: {
        retryable: false,
        suggestedAction: "Install the OpenVPN package via manage_package.",
        alternativeTools: ["list_packages", "manage_package"],
      },
    });
  }
  return allRecords[0] as Record<string, string>;
}

const getOvpnServerTool: ToolDefinition = {
  name: "get_ovpn_server",
  title: "Get OpenVPN Server",
  description:
    "Get the OpenVPN server configuration on a MikroTik router. Throws NOT_FOUND if the OpenVPN package is not installed.",
  inputSchema: getOvpnServerInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getOvpnServerInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Getting OpenVPN server configuration");
    try {
      const records = await context.routerClient.get<RouterOSRecord>(OVPN_SERVER_PATH, {
        limit: undefined,
        offset: undefined,
      });

      const server = fetchOvpnServer(records, parsed.routerId);

      return {
        content: `OpenVPN server on ${context.routerId}: enabled=${server.enabled}, port=${server.port}, protocol=${server.protocol}`,
        structuredContent: { routerId: context.routerId, server },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "get_ovpn_server" });
    }
  },
};

// ─── manage_ovpn_server ───────────────────────────────────────────────────────

const manageOvpnServerInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["enable", "disable", "set"]).describe("Action to perform"),
    port: z.number().int().min(1).max(65535).optional().describe("Listening port (set action only)"),
    mode: z.enum(["ip", "ethernet"]).optional().describe("Tunnel mode (set action only)"),
    protocol: z.enum(["tcp-server", "udp"]).optional().describe("Transport protocol (set action only)"),
    certificate: z.string().optional().describe("Server certificate name (set action only)"),
    cipher: z
      .enum(["blowfish128", "aes128-cbc", "aes192-cbc", "aes256-cbc", "aes128-gcm", "aes256-gcm", "none"])
      .optional()
      .describe("Encryption cipher (set action only)"),
    auth: z
      .enum(["md5", "sha1", "sha256", "sha512", "null"])
      .optional()
      .describe("Authentication algorithm (set action only)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageOvpnServerTool: ToolDefinition = {
  name: "manage_ovpn_server",
  title: "Manage OpenVPN Server",
  description:
    "Enable, disable, or configure the OpenVPN server on a MikroTik router. The server is a singleton — there is only one per router. Throws NOT_FOUND if the OpenVPN package is not installed. For set action, at least one configuration field must be provided.",
  inputSchema: manageOvpnServerInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: [OVPN_SERVER_PATH],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageOvpnServerInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action }, "Managing OpenVPN server");

    try {
      const records = await context.routerClient.get<RouterOSRecord>(OVPN_SERVER_PATH, {
        limit: undefined,
        offset: undefined,
      });

      const server = fetchOvpnServer(records, parsed.routerId);
      const serverId = server[".id"];

      if (parsed.action === "enable" || parsed.action === "disable") {
        const desiredEnabled = parsed.action === "enable";
        const currentEnabled = server.enabled === "yes";

        if (desiredEnabled === currentEnabled) {
          return {
            content: `OpenVPN server on ${context.routerId} is already ${parsed.action}d. No changes made.`,
            structuredContent: { action: "no_change", server },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would ${parsed.action} OpenVPN server on ${context.routerId}.`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "enabled", before: server.enabled, after: desiredEnabled ? "yes" : "no" }],
            },
          };
        }

        await context.routerClient.update(OVPN_SERVER_PATH, serverId, {
          enabled: desiredEnabled ? "yes" : "no",
        });
        log.info({ routerId: context.routerId, action: parsed.action }, "OpenVPN server updated");
        return {
          content: `OpenVPN server on ${context.routerId} ${parsed.action}d.`,
          structuredContent: { action: parsed.action === "enable" ? "enabled" : "disabled", server },
        };
      }

      // set action
      const hasFields =
        parsed.port !== undefined ||
        parsed.mode !== undefined ||
        parsed.protocol !== undefined ||
        parsed.certificate !== undefined ||
        parsed.cipher !== undefined ||
        parsed.auth !== undefined;

      if (!hasFields) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "OVPN_SERVER_NO_FIELDS",
          message: "At least one field must be provided for action set.",
          details: {},
          recoverability: {
            retryable: false,
            suggestedAction: "Provide at least one of: port, mode, protocol, certificate, cipher, auth.",
            alternativeTools: [],
          },
        });
      }

      const updates: Record<string, string> = {};
      const diff: Array<{ property: string; before: string | null; after: string }> = [];

      if (parsed.port !== undefined && server.port !== String(parsed.port)) {
        updates.port = String(parsed.port);
        diff.push({ property: "port", before: server.port ?? null, after: String(parsed.port) });
      }
      if (parsed.mode !== undefined && server.mode !== parsed.mode) {
        updates.mode = parsed.mode;
        diff.push({ property: "mode", before: server.mode ?? null, after: parsed.mode });
      }
      if (parsed.protocol !== undefined && server.protocol !== parsed.protocol) {
        updates.protocol = parsed.protocol;
        diff.push({ property: "protocol", before: server.protocol ?? null, after: parsed.protocol });
      }
      if (parsed.certificate !== undefined && server.certificate !== parsed.certificate) {
        updates.certificate = parsed.certificate;
        diff.push({ property: "certificate", before: server.certificate ?? null, after: parsed.certificate });
      }
      if (parsed.cipher !== undefined && server.cipher !== parsed.cipher) {
        updates.cipher = parsed.cipher;
        diff.push({ property: "cipher", before: server.cipher ?? null, after: parsed.cipher });
      }
      if (parsed.auth !== undefined && server.auth !== parsed.auth) {
        updates.auth = parsed.auth;
        diff.push({ property: "auth", before: server.auth ?? null, after: parsed.auth });
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: `OpenVPN server on ${context.routerId} already matches the requested configuration. No changes made.`,
          structuredContent: { action: "no_change", server },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would update OpenVPN server on ${context.routerId}.`,
          structuredContent: { action: "dry_run", diff },
        };
      }

      await context.routerClient.update(OVPN_SERVER_PATH, serverId, updates);
      log.info({ routerId: context.routerId }, "OpenVPN server configuration updated");
      return {
        content: `Updated OpenVPN server configuration on ${context.routerId}.`,
        structuredContent: { action: "updated", diff },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_ovpn_server" });
    }
  },
};

export const ovpnTools: ToolDefinition[] = [
  listOvpnClientsTool,
  manageOvpnClientTool,
  getOvpnServerTool,
  manageOvpnServerTool,
];

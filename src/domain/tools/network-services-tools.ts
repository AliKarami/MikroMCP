import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("network-services-tools");

// ---------------------------------------------------------------------------
// get_snmp_settings
// ---------------------------------------------------------------------------

const getSnmpSettingsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
  })
  .strict();

const getSnmpSettingsTool: ToolDefinition = {
  name: "get_snmp_settings",
  title: "Get SNMP Settings",
  description: "Retrieve SNMP settings from a MikroTik router.",
  inputSchema: getSnmpSettingsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getSnmpSettingsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Fetching SNMP settings");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("snmp");
      if (!results || results.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "SNMP_NOT_CONFIGURED",
          message: "SNMP settings not found on the router.",
          details: { routerId: parsed.routerId },
          recoverability: {
            retryable: false,
            suggestedAction: "Enable SNMP on the router first.",
          },
        });
      }
      const settings = results[0] as Record<string, string>;
      return {
        content: `SNMP settings on ${context.routerId}: enabled=${settings.enabled ?? "unknown"}`,
        structuredContent: {
          routerId: context.routerId,
          settings,
        },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "get_snmp_settings" });
    }
  },
};

// ---------------------------------------------------------------------------
// get_ntp_settings
// ---------------------------------------------------------------------------

const getNtpSettingsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
  })
  .strict();

const getNtpSettingsTool: ToolDefinition = {
  name: "get_ntp_settings",
  title: "Get NTP Settings",
  description: "Retrieve NTP client settings from a MikroTik router.",
  inputSchema: getNtpSettingsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getNtpSettingsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Fetching NTP settings");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("system/ntp/client");
      if (!results || results.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "NTP_NOT_CONFIGURED",
          message: "NTP client settings not found on the router.",
          details: { routerId: parsed.routerId },
          recoverability: {
            retryable: false,
            suggestedAction: "Configure NTP client on the router first.",
          },
        });
      }
      const settings = results[0] as Record<string, string>;
      return {
        content: `NTP settings on ${context.routerId}: enabled=${settings.enabled ?? "unknown"}`,
        structuredContent: {
          routerId: context.routerId,
          settings,
        },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "get_ntp_settings" });
    }
  },
};

// ---------------------------------------------------------------------------
// list_netwatch_entries
// ---------------------------------------------------------------------------

const listNetwatchEntriesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    host: z.string().optional().describe("Filter by host (substring match)"),
    status: z.enum(["up", "down", "unknown"]).optional().describe("Filter by current status"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of entries to return"),
  })
  .strict();

const listNetwatchEntriesTool: ToolDefinition = {
  name: "list_netwatch_entries",
  title: "List Netwatch Entries",
  description: "List Netwatch monitoring entries on a MikroTik router.",
  inputSchema: listNetwatchEntriesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listNetwatchEntriesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing Netwatch entries");
    try {
      const allEntries = await context.routerClient.get<RouterOSRecord>("tool/netwatch", {
        limit: undefined,
        offset: undefined,
      });

      const filtered = (allEntries as Record<string, string>[])
        .filter((e) => (parsed.host ? (e.host ?? "").includes(parsed.host) : true))
        .filter((e) => (parsed.status ? e.status === parsed.status : true));
      const entries = filtered.slice(0, parsed.limit);

      return {
        content: `Netwatch entries on ${context.routerId}: ${entries.length} returned (${allEntries.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          entries,
          total: allEntries.length,
          returned: entries.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_netwatch_entries" });
    }
  },
};

// ---------------------------------------------------------------------------
// manage_netwatch_entry
// ---------------------------------------------------------------------------

const manageNetwatchEntryInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    host: z.string().describe("Host to monitor — idempotency key"),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("TCP port (optional; ICMP if omitted)"),
    interval: z.string().optional().describe("Check interval (e.g. '1m'; default '1m')"),
    timeout: z.string().optional().describe("Probe timeout (e.g. '500ms')"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageNetwatchEntryTool: ToolDefinition = {
  name: "manage_netwatch_entry",
  title: "Manage Netwatch Entry",
  description:
    "Add, remove, enable, or disable a Netwatch monitoring entry. Idempotent by host+port: add returns already_exists if an entry with the same host and port already exists.",
  inputSchema: manageNetwatchEntryInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["tool/netwatch"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageNetwatchEntryInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, host: parsed.host },
      "Managing Netwatch entry",
    );
    try {
      const allEntries = await context.routerClient.get<RouterOSRecord>("tool/netwatch", {
        limit: undefined,
        offset: undefined,
      });
      const entries = allEntries as Record<string, string>[];

      if (parsed.action === "add") {
        // Find entries matching the host
        const sameHostEntries = entries.filter((e) => e.host === parsed.host);

        // Check for same host + same port (or both port-less)
        const sameHostAndPort = sameHostEntries.find((e) => {
          const existingPort = e.port && e.port !== "0" ? Number(e.port) : undefined;
          return existingPort === parsed.port;
        });

        if (sameHostAndPort) {
          return {
            content: `Netwatch entry for "${parsed.host}" already exists with the same port. No changes made.`,
            structuredContent: { action: "already_exists", entry: sameHostAndPort },
          };
        }

        // Same host, different port → CONFLICT
        if (sameHostEntries.length > 0 && parsed.port !== undefined) {
          const conflicting = sameHostEntries[0];
          const existingPort =
            conflicting.port && conflicting.port !== "0" ? Number(conflicting.port) : undefined;
          if (existingPort !== parsed.port) {
            throw new MikroMCPError({
              category: ErrorCategory.CONFLICT,
              code: "NETWATCH_PORT_CONFLICT",
              message: `Netwatch entry for "${parsed.host}" exists with a different port.`,
              details: { existing: existingPort, requested: parsed.port },
              recoverability: {
                retryable: false,
                suggestedAction: "Remove the existing entry first or use a different host.",
                alternativeTools: ["manage_netwatch_entry"],
              },
            });
          }
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "host", before: null, after: parsed.host },
            ...(parsed.port !== undefined
              ? [{ property: "port", before: null, after: String(parsed.port) }]
              : []),
            ...(parsed.interval
              ? [{ property: "interval", before: null, after: parsed.interval }]
              : []),
            ...(parsed.timeout
              ? [{ property: "timeout", before: null, after: parsed.timeout }]
              : []),
          ];
          return {
            content: `Dry run: Would add Netwatch entry for "${parsed.host}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = { host: parsed.host };
        if (parsed.port !== undefined) body.port = String(parsed.port);
        if (parsed.interval) body.interval = parsed.interval;
        if (parsed.timeout) body.timeout = parsed.timeout;
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("tool/netwatch", body);
        log.info({ host: parsed.host, id: created[".id"] }, "Netwatch entry added");
        return {
          content: `Added Netwatch entry for "${parsed.host}".`,
          structuredContent: { action: "created", entry: created },
        };
      }

      if (parsed.action === "remove") {
        const existing = entries.find((e) => e.host === parsed.host);
        if (!existing) {
          return {
            content: `Netwatch entry for "${parsed.host}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", host: parsed.host },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove Netwatch entry for "${parsed.host}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "host", before: parsed.host, after: null }],
            },
          };
        }
        await context.routerClient.remove("tool/netwatch", existing[".id"]);
        log.info({ host: parsed.host }, "Netwatch entry removed");
        return {
          content: `Removed Netwatch entry for "${parsed.host}".`,
          structuredContent: { action: "removed", host: parsed.host, id: existing[".id"] },
        };
      }

      // enable / disable
      const existing = entries.find((e) => e.host === parsed.host);
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "NETWATCH_ENTRY_NOT_FOUND",
          message: `Netwatch entry for "${parsed.host}" not found.`,
          details: { host: parsed.host },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the host with list_netwatch_entries.",
            alternativeTools: ["list_netwatch_entries"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} Netwatch entry for "${parsed.host}".`,
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

      const disabledValue = parsed.action === "disable" ? "true" : "false";
      await context.routerClient.update("tool/netwatch", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ host: parsed.host, action: resultAction }, "Netwatch entry updated");
      return {
        content: `Netwatch entry for "${parsed.host}" ${resultAction}.`,
        structuredContent: { action: resultAction, host: parsed.host, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_netwatch_entry" });
    }
  },
};

// ---------------------------------------------------------------------------
// list_neighbors
// ---------------------------------------------------------------------------

const listNeighborsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    interface: z.string().optional().describe("Filter by interface name (substring match)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of neighbors to return"),
  })
  .strict();

const listNeighborsTool: ToolDefinition = {
  name: "list_neighbors",
  title: "List Neighbors",
  description: "List discovered neighbors (CDP/LLDP/MNDP) on a MikroTik router.",
  inputSchema: listNeighborsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listNeighborsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing neighbors");
    try {
      const allNeighbors = await context.routerClient.get<RouterOSRecord>("ip/neighbor", {
        limit: undefined,
        offset: undefined,
      });

      const filtered = parsed.interface
        ? (allNeighbors as Record<string, string>[]).filter((n) =>
            (n.interface ?? "").includes(parsed.interface!),
          )
        : (allNeighbors as Record<string, string>[]);
      const neighbors = filtered.slice(0, parsed.limit);

      return {
        content: `Neighbors on ${context.routerId}: ${neighbors.length} returned (${allNeighbors.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          neighbors,
          total: allNeighbors.length,
          returned: neighbors.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_neighbors" });
    }
  },
};

// ---------------------------------------------------------------------------
// list_arp_entries
// ---------------------------------------------------------------------------

const listArpEntriesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    interface: z.string().optional().describe("Filter by interface (substring match)"),
    address: z.string().optional().describe("Filter by IP address (substring match)"),
    macAddress: z.string().optional().describe("Filter by MAC address (substring match)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of ARP entries to return"),
  })
  .strict();

const listArpEntriesTool: ToolDefinition = {
  name: "list_arp_entries",
  title: "List ARP Entries",
  description: "List ARP table entries on a MikroTik router.",
  inputSchema: listArpEntriesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listArpEntriesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing ARP entries");
    try {
      const allEntries = await context.routerClient.get<RouterOSRecord>("ip/arp", {
        limit: undefined,
        offset: undefined,
      });

      const filtered = (allEntries as Record<string, string>[])
        .filter((e) => (parsed.interface ? (e.interface ?? "").includes(parsed.interface) : true))
        .filter((e) => (parsed.address ? (e.address ?? "").includes(parsed.address) : true))
        .filter((e) =>
          parsed.macAddress ? (e["mac-address"] ?? "").includes(parsed.macAddress) : true,
        );
      const entries = filtered.slice(0, parsed.limit);

      return {
        content: `ARP entries on ${context.routerId}: ${entries.length} returned (${allEntries.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          entries,
          total: allEntries.length,
          returned: entries.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_arp_entries" });
    }
  },
};

export const networkServicesTools: ToolDefinition[] = [
  getSnmpSettingsTool,
  getNtpSettingsTool,
  listNetwatchEntriesTool,
  manageNetwatchEntryTool,
  listNeighborsTool,
  listArpEntriesTool,
];

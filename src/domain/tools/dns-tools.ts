import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { paginate, listContent, compactFields } from "./pagination.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("dns-tools");

const listDnsInputSchema = z
  .object({
    routerId,
    name: z.string().optional().describe("Filter by hostname (partial match)"),
    type: z.enum(["A", "CNAME", "TXT", "all"]).default("all").describe("Filter by record type"),
    limit,
    offset,
  })
  .strict();

const listDnsTool: ToolDefinition = {
  name: "list_dns_entries",
  title: "List DNS Entries",
  description:
    "List static DNS entries on a MikroTik router with optional filtering by name and type.",
  inputSchema: listDnsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listDnsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing DNS entries");
    try {
      let entries = await context.routerClient.get<RouterOSRecord>("ip/dns/static", {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.type !== "all") {
        entries = entries.filter((e) => (e as Record<string, string>).type === parsed.type);
      }
      if (parsed.name) {
        const needle = parsed.name.toLowerCase();
        entries = entries.filter((e) =>
          ((e as Record<string, string>).name ?? "").toLowerCase().includes(needle),
        );
      }

      const { items: paginated, total, hasMore } = paginate(entries, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "DNS entries",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (e) => compactFields(e, ["name", "type", "address", "cname", "ttl", "disabled"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          entries: paginated,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_dns_entries");
    }
  },
};

const manageDnsInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().min(1).describe("Hostname for the DNS record (e.g. server.example.com)"),
    type: z.enum(["A", "CNAME", "TXT"]).default("A").describe("DNS record type"),
    address: z.string().optional().describe("IP address (required for A records)"),
    cname: z.string().optional().describe("Target hostname (required for CNAME records)"),
    text: z.string().optional().describe("Text value (required for TXT records)"),
    ttl: z.string().optional().describe("TTL value (e.g. 1d, 00:05:00)"),
    comment: z.string().max(255).optional().describe("Optional comment"),
    disabled: z.boolean().default(false).describe("Whether the entry should be disabled"),
    dryRun,
  })
  .strict();

const manageDnsTool: ToolDefinition = {
  name: "manage_dns_entry",
  title: "Manage DNS Entry",
  description:
    "Add or remove a static DNS entry. Idempotent by name+type: add returns already_exists if the same record already exists.",
  inputSchema: manageDnsInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/dns/static"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageDnsInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name, type: parsed.type },
      "Managing DNS entry",
    );
    try {
      const existing = await context.routerClient.get<RouterOSRecord>("ip/dns/static", {
        filter: { name: parsed.name, type: parsed.type },
      });

      if (parsed.action === "add") {
        if (existing.length > 0) {
          return {
            content: `DNS entry "${parsed.name}" (${parsed.type}) already exists. No changes made.`,
            structuredContent: { action: "already_exists", entry: existing[0] },
          };
        }

        if (parsed.type === "A" && !parsed.address) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DNS_MISSING_ADDRESS",
            message: "address is required for A records.",
            recoverability: { retryable: false, suggestedAction: "Provide the address parameter." },
          });
        }
        if (parsed.type === "CNAME" && !parsed.cname) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DNS_MISSING_CNAME",
            message: "cname is required for CNAME records.",
            recoverability: { retryable: false, suggestedAction: "Provide the cname parameter." },
          });
        }
        if (parsed.type === "TXT" && !parsed.text) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DNS_MISSING_TEXT",
            message: "text is required for TXT records.",
            recoverability: { retryable: false, suggestedAction: "Provide the text parameter." },
          });
        }

        if (parsed.dryRun) {
          const value = parsed.address ?? parsed.cname ?? parsed.text ?? "";
          return {
            content: `Dry run: Would add DNS entry "${parsed.name}" ${parsed.type} → ${value}.`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "name", before: null, after: parsed.name },
                { property: "type", before: null, after: parsed.type },
              ],
            },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          type: parsed.type,
          disabled: parsed.disabled ? "true" : "false",
        };
        if (parsed.address) body.address = parsed.address;
        if (parsed.cname) body.cname = parsed.cname;
        if (parsed.text) body.text = parsed.text;
        if (parsed.ttl) body.ttl = parsed.ttl;
        if (parsed.comment) body.comment = parsed.comment.replace(/[\x00-\x1f\x7f]/g, "");

        const created = await context.routerClient.create("ip/dns/static", body);
        log.info({ name: parsed.name, id: created[".id"] }, "DNS entry created");
        return {
          content: `Added DNS entry "${parsed.name}" (${parsed.type}).`,
          structuredContent: { action: "created", entry: created },
        };
      }

      if (existing.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "DNS_ENTRY_NOT_FOUND",
          message: `DNS entry "${parsed.name}" (${parsed.type}) not found.`,
          details: { name: parsed.name, type: parsed.type },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the entry with list_dns_entries.",
          },
        });
      }

      const rec = existing[0] as Record<string, string>;
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove DNS entry "${parsed.name}" (${parsed.type}).`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }

      await context.routerClient.remove("ip/dns/static", rec[".id"]);
      log.info({ name: parsed.name, type: parsed.type }, "DNS entry removed");
      return {
        content: `Removed DNS entry "${parsed.name}" (${parsed.type}).`,
        structuredContent: {
          action: "removed",
          name: parsed.name,
          type: parsed.type,
          id: rec[".id"],
        },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dns_entry");
    }
  },
};

const getDnsSettingsInputSchema = z
  .object({
    routerId,
  })
  .strict();

const getDnsSettingsTool: ToolDefinition = {
  name: "get_dns_settings",
  title: "Get DNS Settings",
  description:
    "Read DNS resolver configuration: upstream servers, cache size, cache TTL, and whether remote DNS requests are allowed.",
  inputSchema: getDnsSettingsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    getDnsSettingsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Getting DNS settings");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("ip/dns");
      const settings = (
        Array.isArray(results) && results.length > 0 ? results[0] : results
      ) as Record<string, string>;

      const servers = settings.servers ?? settings.server ?? "none";
      const cacheSize = settings["cache-size"] ?? "?";
      const cacheTtl = settings["cache-max-ttl"] ?? "?";
      const allowRemote = settings["allow-remote-requests"] ?? "false";

      return {
        content: [
          `DNS settings on ${context.routerId}:`,
          `  servers: ${servers}`,
          `  cache-size: ${cacheSize}`,
          `  cache-max-ttl: ${cacheTtl}`,
          `  allow-remote-requests: ${allowRemote}`,
        ].join("\n"),
        structuredContent: { routerId: context.routerId, settings },
      };
    } catch (err) {
      throw toolError(err, context, "get_dns_settings");
    }
  },
};

const manageDnsSettingsInputSchema = z
  .object({
    routerId,
    servers: z.string().optional().describe("Comma-separated upstream DNS server IPs (e.g. '8.8.8.8,1.1.1.1')"),
    allowRemoteRequests: z.boolean().optional().describe("Allow router to answer DNS queries from the network"),
    maxUdpPacketSize: z.number().int().min(512).max(65535).optional().describe("Maximum UDP packet size in bytes"),
    cacheMaxTtl: z.string().optional().describe("Maximum cache TTL (e.g. '1d', '00:30:00')"),
    cacheSize: z.number().int().min(1).optional().describe("DNS cache size in KiB"),
    dryRun,
  })
  .strict();

const manageDnsSettingsTool: ToolDefinition = {
  name: "manage_dns_settings",
  title: "Manage DNS Settings",
  description:
    "Update DNS resolver settings (upstream servers, cache size, cache TTL, allow-remote-requests). Idempotent: returns no_change if nothing differs.",
  inputSchema: manageDnsSettingsInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/dns"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageDnsSettingsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Managing DNS settings");
    try {
      const results = await context.routerClient.get<RouterOSRecord>("ip/dns");
      const current = (Array.isArray(results) && results.length > 0 ? results[0] : results) as Record<string, string>;
      const id = current[".id"];

      const changes: Record<string, string> = {};
      const diff: { property: string; before: string | null; after: string }[] = [];

      if (parsed.servers !== undefined && current.servers !== parsed.servers) {
        changes.servers = parsed.servers;
        diff.push({ property: "servers", before: current.servers ?? null, after: parsed.servers });
      }
      if (parsed.allowRemoteRequests !== undefined) {
        const next = String(parsed.allowRemoteRequests);
        if (current["allow-remote-requests"] !== next) {
          changes["allow-remote-requests"] = next;
          diff.push({ property: "allow-remote-requests", before: current["allow-remote-requests"] ?? null, after: next });
        }
      }
      if (parsed.maxUdpPacketSize !== undefined) {
        const next = String(parsed.maxUdpPacketSize);
        if (current["max-udp-packet-size"] !== next) {
          changes["max-udp-packet-size"] = next;
          diff.push({ property: "max-udp-packet-size", before: current["max-udp-packet-size"] ?? null, after: next });
        }
      }
      if (parsed.cacheMaxTtl !== undefined && current["cache-max-ttl"] !== parsed.cacheMaxTtl) {
        changes["cache-max-ttl"] = parsed.cacheMaxTtl;
        diff.push({ property: "cache-max-ttl", before: current["cache-max-ttl"] ?? null, after: parsed.cacheMaxTtl });
      }
      if (parsed.cacheSize !== undefined) {
        const next = String(parsed.cacheSize);
        if (current["cache-size"] !== next) {
          changes["cache-size"] = next;
          diff.push({ property: "cache-size", before: current["cache-size"] ?? null, after: next });
        }
      }

      if (Object.keys(changes).length === 0) {
        return {
          content: "DNS settings already match requested values. No changes made.",
          structuredContent: { action: "no_change", routerId: context.routerId },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would update DNS settings on ${context.routerId}.`,
          structuredContent: { action: "dry_run", diff },
        };
      }

      await context.routerClient.update("ip/dns", id, changes);
      log.info({ routerId: context.routerId, changes: Object.keys(changes) }, "DNS settings updated");
      return {
        content: `Updated DNS settings on ${context.routerId}.`,
        structuredContent: { action: "updated", routerId: context.routerId, diff },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dns_settings");
    }
  },
};

export const dnsTools: ToolDefinition[] = [listDnsTool, manageDnsTool, getDnsSettingsTool, manageDnsSettingsTool];

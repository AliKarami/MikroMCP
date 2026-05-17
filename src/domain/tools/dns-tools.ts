import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("dns-tools");

const listDnsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by hostname (partial match)"),
    type: z.enum(["A", "CNAME", "TXT", "all"]).default("all").describe("Filter by record type"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of entries to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
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

      const total = entries.length;
      const paginated = entries.slice(parsed.offset, parsed.offset + parsed.limit);
      const hasMore = parsed.offset + parsed.limit < total;

      const lines = [`DNS entries on ${context.routerId}: ${total} total`];
      for (const entry of paginated) {
        const rec = entry as Record<string, string>;
        const value = rec.address ?? rec.cname ?? rec.text ?? "?";
        lines.push(`  ${rec.name} ${rec.type ?? "A"} → ${value}`);
      }

      return {
        content: lines.join("\n"),
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
      throw enrichError(err, { routerId: context.routerId, tool: "list_dns_entries" });
    }
  },
};

const manageDnsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().min(1).describe("Hostname for the DNS record (e.g. server.example.com)"),
    type: z.enum(["A", "CNAME", "TXT"]).default("A").describe("DNS record type"),
    address: z.string().optional().describe("IP address (required for A records)"),
    cname: z.string().optional().describe("Target hostname (required for CNAME records)"),
    text: z.string().optional().describe("Text value (required for TXT records)"),
    ttl: z.string().optional().describe("TTL value (e.g. 1d, 00:05:00)"),
    comment: z.string().max(255).optional().describe("Optional comment"),
    disabled: z.boolean().default(false).describe("Whether the entry should be disabled"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
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
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_dns_entry" });
    }
  },
};

const getDnsSettingsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
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
      throw enrichError(err, { routerId: context.routerId, tool: "get_dns_settings" });
    }
  },
};

export const dnsTools: ToolDefinition[] = [listDnsTool, manageDnsTool, getDnsSettingsTool];

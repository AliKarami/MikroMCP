import { z } from "zod";
import { isTrue, normalizeWireValue, sameValue } from "../../adapter/response-parser.js";
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
    name: z
      .string()
      .min(1)
      .describe(
        "Hostname for the DNS record (e.g. server.example.com); matched case-insensitively",
      ),
    type: z.enum(["A", "CNAME", "TXT"]).default("A").describe("DNS record type"),
    address: z
      .string()
      .optional()
      .describe(
        "IP address (required for A records; on remove, picks the record when several share the name)",
      ),
    cname: z
      .string()
      .optional()
      .describe(
        "Target hostname (required for CNAME records; on remove, picks the record when several share the name)",
      ),
    text: z
      .string()
      .optional()
      .describe(
        "Text value (required for TXT records; on remove, picks the record when several share the name)",
      ),
    ttl: z.string().optional().describe("TTL value (e.g. 1d, 00:05:00)"),
    comment: z.string().max(255).optional().describe("Optional comment"),
    disabled: z.boolean().default(false).describe("Whether the entry should be disabled"),
    dryRun,
  })
  .strict();

/** The record field that carries the value of each supported record type. */
const VALUE_FIELD = { A: "address", CNAME: "cname", TXT: "text" } as const;

const TIME_UNIT_MS: Record<string, number> = {
  w: 604_800_000,
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
};

/**
 * Milliseconds in a RouterOS time value: unit groups in any order (`1d`,
 * `24h`, `1w2d`, `2d1w`, `5m30s`, `500ms`), an optional trailing clock
 * (`00:05:00`, `1d 02:00:00`, `00:00:01.500`), or plain seconds (`300`, which
 * the parser turns into a number). RouterOS stores a TTL in its own canonical
 * form (`00:05:00` reads back as `5m`), so TTLs are compared by duration.
 * Undefined when the value does not parse.
 */
function ttlMillis(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value * 1_000 : undefined;
  if (typeof value !== "string") return undefined;
  let rest = value.trim();
  if (/^\d+$/.test(rest)) return Number(rest) * 1_000;

  let total = 0;
  const clock = /(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(rest);
  if (clock) {
    const [, h, m, s, frac = ""] = clock;
    total += ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1_000 + Number(frac.padEnd(3, "0"));
    rest = rest.slice(0, clock.index).trim();
  }
  if (rest === "") return clock ? total : undefined;
  if (!/^(?:\d+(?:ms|[wdhms])\s*)+$/.test(rest)) return undefined;
  for (const [, amount, unit] of rest.matchAll(/(\d+)(ms|[wdhms])/g)) {
    total += Number(amount) * TIME_UNIT_MS[unit];
  }
  return total;
}

function sameTtl(stored: unknown, requested: string): boolean {
  const a = ttlMillis(stored);
  const b = ttlMillis(requested);
  return a !== undefined && b !== undefined
    ? a === b
    : normalizeWireValue(stored) === normalizeWireValue(requested);
}

const manageDnsTool: ToolDefinition = {
  name: "manage_dns_entry",
  title: "Manage DNS Entry",
  description:
    "Add or remove a static DNS entry, found by name (case-insensitive) and type. add returns already_exists if such a record already has the requested value and disabled state (and ttl/comment, when given), and throws CONFLICT if it differs; add never creates a second record with the same name and type. remove deletes the one matching record; when several share the name (round-robin), pass address/cname/text to pick one.",
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
      const valueField = VALUE_FIELD[parsed.type];
      const value = parsed[valueField];
      const comment = parsed.comment?.replace(/[\x00-\x1f\x7f]/g, "");
      const valueFields = ["address", "cname", "text"] as const;

      for (const field of valueFields) {
        if (field !== valueField && parsed[field] !== undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "DNS_FIELD_NOT_APPLICABLE",
            message: `${field} does not apply to ${parsed.type} records; ${parsed.type} uses ${valueField}.`,
            details: { field, type: parsed.type },
            recoverability: {
              retryable: false,
              suggestedAction: `Drop ${field}, or set type to the record type it belongs to.`,
            },
          });
        }
      }
      if (parsed.action === "add" && !value) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: `DNS_MISSING_${valueField.toUpperCase()}`,
          message: `${valueField} is required for ${parsed.type} records.`,
          recoverability: {
            retryable: false,
            suggestedAction: `Provide the ${valueField} parameter.`,
          },
        });
      }

      // DNS names are case-insensitive, while the REST filter matches exactly:
      // filter by type on the router and compare the name here, so Router.LAN
      // finds router.lan.
      const wantName = parsed.name.toLowerCase();
      const existing = (
        await context.routerClient.get<RouterOSRecord>("ip/dns/static", {
          filter: { type: parsed.type },
        })
      ).filter((entry) => String(entry.name ?? "").toLowerCase() === wantName);

      const detailsOf = (entry: RouterOSRecord) => ({
        [valueField]: entry[valueField],
        disabled: entry.disabled,
        ttl: entry.ttl,
        comment: entry.comment,
      });
      const describe = (fields: Record<string, unknown>) =>
        compactFields(fields, [valueField, "disabled", "ttl", "comment"]);

      if (parsed.action === "add") {
        if (existing.length > 0) {
          // RouterOS allows several records with one name (round-robin A), so
          // any record that matches the request counts as already present.
          const match = existing.find(
            (rec) =>
              normalizeWireValue(rec[valueField]) === normalizeWireValue(value) &&
              isTrue(rec.disabled) === parsed.disabled &&
              (parsed.ttl === undefined || sameTtl(rec.ttl, parsed.ttl)) &&
              (comment === undefined ||
                normalizeWireValue(rec.comment) === normalizeWireValue(comment)),
          );

          if (match) {
            return {
              content: `DNS entry "${parsed.name}" (${parsed.type}) already exists. No changes made.`,
              structuredContent: { action: "already_exists", entry: match },
            };
          }

          const existingDetails = existing.map(detailsOf);
          const requestedDetails: Record<string, unknown> = {
            [valueField]: value,
            disabled: parsed.disabled ? "true" : "false",
            ttl: parsed.ttl,
            comment,
          };

          // The message names the values on both sides, so the conflict reads
          // without parsing details.
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "DNS_ENTRY_CONFLICT",
            message:
              `DNS entry "${parsed.name}" (${parsed.type}) already exists but with different configuration. ` +
              `Existing: ${existingDetails.map(describe).join("; ")}. ` +
              `Requested: ${describe(requestedDetails)}.`,
            details: { existing: existingDetails, requested: requestedDetails },
            recoverability: {
              retryable: false,
              suggestedAction:
                existing.length > 1
                  ? `${existing.length} records share this name. Remove each one with action=remove and its ${valueField}, then re-add. add does not create a second record with the same name and type.`
                  : "Remove the existing entry with action=remove, then re-add it with the desired values. add does not create a second record with the same name and type.",
              alternativeTools: ["manage_dns_entry with action=remove"],
            },
          });
        }

        if (parsed.dryRun) {
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
          [valueField]: value!,
        };
        if (parsed.ttl) body.ttl = parsed.ttl;
        if (comment) body.comment = comment;

        const created = await context.routerClient.create("ip/dns/static", body);
        log.info({ name: parsed.name, id: created[".id"] }, "DNS entry created");
        return {
          content: `Added DNS entry "${parsed.name}" (${parsed.type}).`,
          structuredContent: { action: "created", entry: created },
        };
      }

      const candidates =
        value === undefined
          ? existing
          : existing.filter(
              (rec) => normalizeWireValue(rec[valueField]) === normalizeWireValue(value),
            );

      if (candidates.length === 0) {
        const label = value === undefined ? "" : ` with ${valueField}=${value}`;
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "DNS_ENTRY_NOT_FOUND",
          message:
            `DNS entry "${parsed.name}" (${parsed.type})${label} not found.` +
            (existing.length > 0
              ? ` Existing: ${existing.map((rec) => describe(detailsOf(rec))).join("; ")}.`
              : ""),
          details: { name: parsed.name, type: parsed.type, [valueField]: value },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the entry with list_dns_entries.",
          },
        });
      }

      if (candidates.length > 1) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "DNS_ENTRY_AMBIGUOUS",
          message:
            `${candidates.length} DNS entries "${parsed.name}" (${parsed.type}) match: ` +
            `${candidates.map((rec) => describe(detailsOf(rec))).join("; ")}.`,
          details: { name: parsed.name, type: parsed.type, entries: candidates.map(detailsOf) },
          recoverability: {
            retryable: false,
            suggestedAction: `Pass ${valueField} to pick the record to remove.`,
          },
        });
      }

      const rec = candidates[0];
      const id = rec[".id"];
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove DNS entry "${parsed.name}" (${parsed.type}).`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }

      await context.routerClient.remove("ip/dns/static", id);
      log.info({ name: parsed.name, type: parsed.type }, "DNS entry removed");
      return {
        content: `Removed DNS entry "${parsed.name}" (${parsed.type}).`,
        structuredContent: {
          action: "removed",
          name: parsed.name,
          type: parsed.type,
          id,
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
    servers: z
      .string()
      .optional()
      .describe("Comma-separated upstream DNS server IPs (e.g. '8.8.8.8,1.1.1.1')"),
    allowRemoteRequests: z
      .boolean()
      .optional()
      .describe("Allow router to answer DNS queries from the network"),
    maxUdpPacketSize: z
      .number()
      .int()
      .min(512)
      .max(65535)
      .optional()
      .describe("Maximum UDP packet size in bytes"),
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
      const current = (
        Array.isArray(results) && results.length > 0 ? results[0] : results
      ) as Record<string, string>;

      const changes: Record<string, string> = {};
      const diff: { property: string; before: string | null; after: string }[] = [];

      if (parsed.servers !== undefined && current.servers !== parsed.servers) {
        changes.servers = parsed.servers;
        diff.push({ property: "servers", before: current.servers ?? null, after: parsed.servers });
      }
      if (parsed.allowRemoteRequests !== undefined) {
        const next = String(parsed.allowRemoteRequests);
        if (isTrue(current["allow-remote-requests"]) !== parsed.allowRemoteRequests) {
          changes["allow-remote-requests"] = next;
          diff.push({
            property: "allow-remote-requests",
            before:
              current["allow-remote-requests"] === undefined
                ? null
                : String(current["allow-remote-requests"]),
            after: next,
          });
        }
      }
      if (parsed.maxUdpPacketSize !== undefined) {
        const next = String(parsed.maxUdpPacketSize);
        if (!sameValue(current["max-udp-packet-size"], next)) {
          changes["max-udp-packet-size"] = next;
          diff.push({
            property: "max-udp-packet-size",
            before:
              current["max-udp-packet-size"] === undefined
                ? null
                : String(current["max-udp-packet-size"]),
            after: next,
          });
        }
      }
      if (parsed.cacheMaxTtl !== undefined && current["cache-max-ttl"] !== parsed.cacheMaxTtl) {
        changes["cache-max-ttl"] = parsed.cacheMaxTtl;
        diff.push({
          property: "cache-max-ttl",
          before: current["cache-max-ttl"] ?? null,
          after: parsed.cacheMaxTtl,
        });
      }
      if (parsed.cacheSize !== undefined) {
        const next = String(parsed.cacheSize);
        if (!sameValue(current["cache-size"], next)) {
          changes["cache-size"] = next;
          diff.push({
            property: "cache-size",
            before: current["cache-size"] === undefined ? null : String(current["cache-size"]),
            after: next,
          });
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

      // Set-menu singletons carry no `.id` — writes go through the /set command.
      await context.routerClient.execute("ip/dns/set", changes);
      log.info(
        { routerId: context.routerId, changes: Object.keys(changes) },
        "DNS settings updated",
      );
      return {
        content: `Updated DNS settings on ${context.routerId}.`,
        structuredContent: { action: "updated", routerId: context.routerId, diff },
      };
    } catch (err) {
      throw toolError(err, context, "manage_dns_settings");
    }
  },
};

export const dnsTools: ToolDefinition[] = [
  listDnsTool,
  manageDnsTool,
  getDnsSettingsTool,
  manageDnsSettingsTool,
];

// ---------------------------------------------------------------------------
// MikroMCP - SwOS / SwOS Lite tools
//
// These tools run only against devices configured with `deviceType: "swos"`
// (MikroTik switch firmware — SwOS or SwOS Lite). They speak the ".b" HTTP API
// reverse-engineered from the web UI — see src/adapter/swos-protocol.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { createLogger } from "../../observability/logger.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import {
  SWOS_ENDPOINTS,
  SWOS_SCHEMA,
  dumpBlob,
  encodeLike,
  firmwareSupport,
  isWireHex,
  Kind,
  unmappedWireKeys,
  type DecodedBlob,
  type Field,
  type FirmwareSupport,
} from "../../adapter/swos-protocol.js";
import type { SwosClient } from "../../adapter/swos-client.js";

const log = createLogger("swos-tools");

const endpointEnum = z.enum(SWOS_ENDPOINTS as [string, ...string[]]);

/** Cap on human-readable tool text; structuredContent is never truncated. */
const MAX_CONTENT_CHARS = 8_000;

function requireSwosClient(context: ToolContext): SwosClient {
  if (!context.swosClient) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "PLATFORM_MISMATCH",
      message: `Router "${context.routerId}" is not configured as a SwOS switch (deviceType: "swos").`,
      recoverability: {
        retryable: false,
        suggestedAction:
          'Set deviceType: "swos" for this device in routers.yaml, or target a switch.',
      },
    });
  }
  return context.swosClient;
}

/**
 * Identify the firmware behind a write. Never fails the call: an unreadable
 * `sys.b` makes the write *unverified*, not impossible.
 */
async function readFirmwareSupport(client: SwosClient): Promise<FirmwareSupport> {
  try {
    const sys = (await client.get("sys.b")) as Record<string, unknown>;
    return firmwareSupport(sys.model, sys.version);
  } catch (err) {
    log.warn({ err }, "Could not read sys.b for the firmware compatibility check");
    return {
      verified: false,
      note: `Firmware could not be read (${err instanceof Error ? err.message : String(err)}); compatibility unknown.`,
    };
  }
}

// ---------------------------------------------------------------------------
// list_swos_endpoints
// ---------------------------------------------------------------------------

const listEndpointsSchema = z
  .object({
    routerId,
  })
  .strict();

const listSwosEndpointsTool: ToolDefinition = {
  name: "list_swos_endpoints",
  title: "List SwOS Endpoints",
  description:
    "List the SwOS/SwOS Lite '.b' API endpoints supported by this server, with the decoded field names per endpoint. Read-only schema introspection — no device call.",
  inputSchema: listEndpointsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    listEndpointsSchema.parse(params);
    const endpoints = SWOS_ENDPOINTS.map((ep) => ({
      endpoint: ep,
      fields: SWOS_SCHEMA[ep].fields.map((f) => f.name),
    }));
    const content = endpoints
      .map(
        (e) =>
          `${e.endpoint}\n  fields: ${e.fields.length > 0 ? e.fields.join(", ") : "(decoded generically per port)"}`,
      )
      .join("\n");
    return {
      content: `SwOS endpoints:\n${content}`,
      structuredContent: { routerId: context.routerId, endpoints },
    };
  },
};

// ---------------------------------------------------------------------------
// get_swos_status
// ---------------------------------------------------------------------------

const STATUS_ENDPOINTS = ["link.b", "sys.b", "poe.b", "sfp.b"] as const;

const getStatusSchema = z
  .object({
    routerId,
    include: z
      .array(z.enum(STATUS_ENDPOINTS))
      .default([...STATUS_ENDPOINTS])
      .describe("Which status endpoints to fetch"),
  })
  .strict();

/** A section that failed to fetch, carrying the reason instead of decoded data. */
interface SectionError {
  _error: string;
}

function sectionOf(
  sections: Record<string, unknown>,
  endpoint: string,
): Record<string, unknown> | undefined {
  const section = sections[endpoint] as Record<string, unknown> | undefined;
  return section && !("_error" in section) ? section : undefined;
}

function formatStatus(sections: Record<string, unknown>): string {
  const lines: string[] = [];
  const sys = sectionOf(sections, "sys.b");
  if (sys) {
    const firmware = firmwareSupport(sys.model, sys.version);
    lines.push("Switch:");
    if (sys.identity) lines.push(`  Identity: ${sys.identity}`);
    if (sys.model) lines.push(`  Model: ${sys.model}`);
    if (sys.version) {
      lines.push(
        `  Firmware: ${sys.version}${firmware.verified ? " (schema verified)" : " (schema not verified for this firmware — see the note on writes)"}`,
      );
    }
    if (sys.serial) lines.push(`  Serial: ${sys.serial}`);
    if (sys.uptime) lines.push(`  Uptime: ${String(sys.uptime)}s`);
    if (sys.ip) lines.push(`  IP: ${sys.ip}`);
    if (sys.mac) lines.push(`  MAC: ${sys.mac}`);
  }

  const link = sectionOf(sections, "link.b");
  if (link) {
    const names = link.name as unknown[] | undefined;
    const speeds = link.speed as unknown[] | undefined;
    const links = link.link as unknown[] | undefined;
    const dups = link.duplex as unknown[] | undefined;
    const count = Math.max(names?.length ?? 0, speeds?.length ?? 0, links?.length ?? 0);
    lines.push("Ports:");
    for (let i = 0; i < count; i++) {
      const name = names?.[i] ?? `port${i + 1}`;
      const speed = speeds?.[i] ?? "?";
      const linkState = links?.[i] ? "up" : "down";
      const dup = dups?.[i] === undefined ? "?" : dups[i] ? "full" : "half";
      lines.push(`  ${String(name)}: ${linkState} (${String(speed)} ${dup})`);
    }
  }

  const poe = sectionOf(sections, "poe.b");
  if (poe) {
    const out = poe.out as unknown[] | undefined;
    const state = poe.state as unknown[] | undefined;
    const power = poe.power as unknown[] | undefined;
    const count = Math.max(out?.length ?? 0, state?.length ?? 0);
    lines.push("PoE:");
    for (let i = 0; i < count; i++) {
      const mode = out?.[i] ?? "?";
      const st = state?.[i] ?? "?";
      const pw = power?.[i] !== undefined ? `${String(power[i])}W` : "";
      lines.push(`  port${i + 1}: ${String(mode)} / ${String(st)} ${pw}`.trimEnd());
    }
  }

  const sfp = sectionOf(sections, "sfp.b");
  if (sfp) {
    const cages = Math.max(
      ...["vendor", "part_number", "serial", "temperature"].map(
        (key) => (sfp[key] as unknown[] | undefined)?.length ?? 0,
      ),
    );
    if (cages > 0) {
      lines.push("SFP modules:");
      for (let i = 0; i < cages; i++) {
        const vendor = (sfp.vendor as unknown[] | undefined)?.[i];
        const part = (sfp.part_number as unknown[] | undefined)?.[i];
        if (!vendor && !part) continue;
        const serial = (sfp.serial as unknown[] | undefined)?.[i];
        const temp = (sfp.temperature as unknown[] | undefined)?.[i];
        lines.push(
          `  sfp${i + 1}: ${String(vendor ?? "?")} ${String(part ?? "?")}` +
            `${serial ? ` sn=${String(serial)}` : ""}${temp !== undefined ? ` ${String(temp)}°C` : ""}`,
        );
      }
    }
  }

  const failed = Object.entries(sections)
    .filter(([, v]) => v && typeof v === "object" && "_error" in (v as object))
    .map(([ep, v]) => `  ${ep}: ${(v as SectionError)._error}`);
  if (failed.length > 0) lines.push("Sections that failed to load:", ...failed);

  return lines.length > 0 ? lines.join("\n") : "No status retrieved.";
}

const getSwosStatusTool: ToolDefinition = {
  name: "get_swos_status",
  title: "Get SwOS Status",
  description:
    "Retrieve status from a MikroTik SwOS switch (SwOS or SwOS Lite): identity, model, firmware, uptime, per-port link state/speed/duplex, PoE mode/state/power, and SFP modules.",
  inputSchema: getStatusSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getStatusSchema.parse(params);
    const client = requireSwosClient(context);
    const sections: Record<string, unknown> = {};
    for (const ep of parsed.include) {
      try {
        sections[ep] = await client.get(ep);
      } catch (err) {
        log.warn({ ep, err }, "SwOS status section failed, skipping");
        sections[ep] = { _error: err instanceof Error ? err.message : String(err) };
      }
    }
    const sys = sectionOf(sections, "sys.b");
    return {
      content: formatStatus(sections),
      structuredContent: {
        routerId: context.routerId,
        sections,
        ...(sys ? { compatibility: firmwareSupport(sys.model, sys.version) } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// get_swos_endpoint
// ---------------------------------------------------------------------------

const getEndpointSchema = z
  .object({
    routerId,
    endpoint: endpointEnum.describe("'.b' endpoint to fetch (see list_swos_endpoints)"),
  })
  .strict();

const getSwosEndpointTool: ToolDefinition = {
  name: "get_swos_endpoint",
  title: "Get SwOS Endpoint",
  description:
    "Fetch and decode a single SwOS '.b' endpoint (link.b, sys.b, poe.b, lacp.b, rstp.b, snmp.b, fwd.b, vlan.b, stats.b, sfp.b, host.b, acl.b, ...) as structured data. Unknown keys are preserved under '_raw'.",
  inputSchema: getEndpointSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getEndpointSchema.parse(params);
    const client = requireSwosClient(context);
    try {
      const decoded = await client.get(parsed.endpoint);
      const rendered = JSON.stringify(decoded, null, 2);
      // Structured content always carries the full decode; only the human-readable
      // text is capped, so a wide endpoint (stats.b) can't flood the context.
      const content =
        rendered.length > MAX_CONTENT_CHARS
          ? `${rendered.slice(0, MAX_CONTENT_CHARS)}\n… truncated (${rendered.length} chars). Full decode is in structuredContent.`
          : rendered;
      return {
        content,
        structuredContent: { routerId: context.routerId, endpoint: parsed.endpoint, data: decoded },
      };
    } catch (err) {
      throw toolError(err, context, "get_swos_endpoint");
    }
  },
};

// ---------------------------------------------------------------------------
// write_swos_blob
// ---------------------------------------------------------------------------

// Two kinds of endpoint are withheld as write targets:
//   * "!" prefixed — device-generated status tables (counters, learned MACs,
//     snooping groups); read-only on the firmware.
//   * record lists (vlan.b, host.b, acl.b) — a whole-blob field merge has no
//     meaning for a list of rows, and writing one would replace the table
//     rather than edit it.
const WRITABLE_ENDPOINTS = SWOS_ENDPOINTS.filter(
  (ep) => !ep.startsWith("!") && !SWOS_SCHEMA[ep].isArray,
);

const writeBlobSchema = z
  .object({
    routerId,
    endpoint: z
      .enum(WRITABLE_ENDPOINTS as [string, ...string[]])
      .describe("'.b' endpoint to write"),
    fields: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number(), z.boolean()])),
        ]),
      )
      .describe(
        "Values to set, keyed by decoded field name (from list_swos_endpoints) or by a raw wire key already present in the blob — anything else is rejected. Option fields take the enum name (e.g. 'auto'); text becomes a UTF-8 hex string; numbers and '0x...' strings are written as hex, padded to the width of the value they replace. A per-port field given a single value applies it to EVERY port.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Preview the resulting blob without writing to the switch."),
  })
  .strict();

/** Resolve a field definition by decoded name or raw wire key. */
function resolveField(epKey: string, key: string): Field | undefined {
  const ep = SWOS_SCHEMA[epKey];
  if (!ep) return undefined;
  return ep.fields.find(
    (field) => field.name === key || Object.values(field.keys).includes(key),
  );
}

/**
 * The wire key this field uses on *this* device. A schema field carries one key
 * per firmware dialect (SwOS mnemonic vs SwOS Lite iNN), so pick the one the
 * blob actually contains rather than assuming a dialect.
 *
 * Returns undefined when neither key is in the blob: the field does not exist
 * on this model/firmware. Writing it anyway would inject a key the device never
 * sent — silently reporting success while changing nothing.
 */
function resolveWireKey(field: Field, wire: DecodedBlob): string | undefined {
  return Object.values(field.keys).find((key) => key in wire);
}

function validationError(code: string, message: string, suggestedAction: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code,
    message,
    recoverability: { retryable: false, suggestedAction },
  });
}

/**
 * Convert a user-supplied value into the wire representation of a field,
 * matching the width of the value it replaces.
 */
function coerceValue(field: Field, value: unknown, existing: unknown): unknown {
  if (Array.isArray(value)) {
    const existingItems = Array.isArray(existing) ? existing : [];
    return value.map((v, i) => coerceScalar(field, v, existingItems[i]));
  }
  return coerceScalar(field, value, existing);
}

function coerceScalar(field: Field, value: unknown, existing: unknown): unknown {
  if (typeof value === "boolean") {
    // A BOOL field is one bitmask covering every port, so `true` would encode
    // as 0x0001 — enabling port 1 and clearing all the others. Refuse rather
    // than silently reconfigure nine ports the caller never mentioned.
    if (field.kind === Kind.BOOL) {
      throw validationError(
        "SWOS_FIELD_SHAPE_MISMATCH",
        `Field "${field.name}" is a per-port bitmask, not a single flag.`,
        "Pass the mask as a number — e.g. 1023 for all 10 ports, 0 for none.",
      );
    }
    return encodeLike(value ? 1 : 0, existing);
  }
  if (typeof value === "number") return encodeLike(value, existing);
  if (field.kind === Kind.OPTION) {
    const idx = (field.options ?? []).indexOf(String(value));
    if (idx < 0) {
      throw validationError(
        "SWOS_INVALID_OPTION",
        `Invalid option "${String(value)}" for field "${field.name}".`,
        `Use one of: ${(field.options ?? []).join(", ")}.`,
      );
    }
    return encodeLike(idx, existing);
  }
  // Strings are either a verbatim hex token or text the firmware stores hex-encoded.
  const text = String(value);
  return isWireHex(text) ? text : Buffer.from(text, "utf8").toString("hex");
}

/**
 * The replacement must have the same shape as the value it overwrites: a
 * per-port array of the same length, or a scalar where the wire holds a scalar.
 *
 * Rejecting the decoded array form (what `get_swos_endpoint` returns) prevents
 * a copy-paste round-trip from rewriting a bitmask as an array, and pinning the
 * length prevents a short array from silently truncating the port list of a
 * whole-blob write.
 */
function assertShapeMatches(
  perPort: boolean,
  key: string,
  next: unknown,
  existing: unknown,
): void {
  if (existing === undefined) return;

  if (Array.isArray(next) && Array.isArray(existing)) {
    if (next.length === existing.length) return;
    throw validationError(
      "SWOS_FIELD_SHAPE_MISMATCH",
      `Field "${key}" holds ${existing.length} value(s) on the wire, but ${next.length} were given.`,
      `Pass exactly ${existing.length} value(s), or a single value to apply to all of them.`,
    );
  }
  if (!Array.isArray(next) && !Array.isArray(existing)) return;
  if (!Array.isArray(next) && perPort) return; // scalar broadcast to all ports
  throw validationError(
    "SWOS_FIELD_SHAPE_MISMATCH",
    Array.isArray(next)
      ? `Field "${key}" is a single per-port bitmask on the wire, but an array was given.`
      : `Field "${key}" is a per-port array on the wire, but a single value was given.`,
    Array.isArray(next)
      ? "Pass the bitmask as one number (e.g. 1023 for all 10 ports)."
      : "Pass one value per port.",
  );
}

const writeSwosBlobTool: ToolDefinition = {
  name: "write_swos_blob",
  title: "Write SwOS Blob",
  description:
    "Mutate a SwOS '.b' endpoint on a MikroTik switch. The full endpoint blob is read, the given fields are merged in, and the entire blob is written back (the firmware only accepts whole-blob writes); untouched fields are re-sent byte-for-byte, and a field this firmware does not expose is refused rather than injected. dryRun defaults to true — preview first. Every result reports whether the schema has been verified against the switch's firmware. The pre-write blob is snapshotted, so the change can be undone with rollback_change. Returns no_change when the values already match.",
  inputSchema: writeBlobSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  platform: "swos",
  // The endpoint is an argument, so the snapshot path is too. The executor
  // captures the pre-write blob verbatim; rollback_change re-POSTs it.
  snapshotPaths: (params) => (params.endpoint ? [String(params.endpoint)] : []),
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = writeBlobSchema.parse(params);
    const client = requireSwosClient(context);
    try {
      const wire = (await client.readBlob(parsed.endpoint)) as DecodedBlob;

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(parsed.fields)) {
        const field = resolveField(parsed.endpoint, key);
        const targetKey = field ? resolveWireKey(field, wire) : key;
        if (targetKey === undefined || !(targetKey in wire)) {
          throw validationError(
            "SWOS_UNKNOWN_FIELD",
            field
              ? `Field "${key}" is not present in ${parsed.endpoint} on this device — its firmware does not expose it.`
              : `Unknown field "${key}" for endpoint ${parsed.endpoint}.`,
            `Read the endpoint first; only keys the device actually sent can be written: ${Object.keys(wire).join(", ")}.`,
          );
        }

        const existing = wire[targetKey];
        const next = field ? coerceValue(field, value, existing) : value;
        assertShapeMatches(field?.perPort ?? false, key, next, existing);

        if (field?.perPort && !Array.isArray(next) && Array.isArray(existing)) {
          wire[targetKey] = existing.map(() => next);
        } else {
          wire[targetKey] = next;
        }
        changes[key] = { from: existing, to: wire[targetKey] };
      }

      const modified = Object.entries(changes).filter(
        ([, c]) => JSON.stringify(c.from) !== JSON.stringify(c.to),
      );
      if (modified.length === 0) {
        return {
          content: `No change: ${parsed.endpoint} on ${context.routerId} already has these values.`,
          structuredContent: {
            routerId: context.routerId,
            endpoint: parsed.endpoint,
            action: "no_change",
            changes,
          },
        };
      }

      const diff = modified
        .map(([key, c]) => `  ${key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`)
        .join("\n");
      const preview = dumpBlob(wire);

      // Compatibility is reported on every real write and every preview, so an
      // unverified firmware is stated before the change, not discovered after.
      const firmware = await readFirmwareSupport(client);
      const unmapped = unmappedWireKeys(parsed.endpoint, wire);
      const banner =
        `${firmware.verified ? "Firmware" : "⚠️  Firmware"}: ${firmware.note}` +
        (unmapped.length > 0
          ? `\n⚠️  ${unmapped.length} key(s) in ${parsed.endpoint} are not in the schema and are re-sent unchanged: ${unmapped.join(", ")}`
          : "");
      const compatibility = { ...firmware, unmappedKeys: unmapped };

      if (parsed.dryRun) {
        return {
          content:
            `DRY RUN — no write performed. ${modified.length} field(s) would change on ${parsed.endpoint}:\n${diff}\n\n` +
            `${banner}\n\nResulting blob:\n${preview}`,
          structuredContent: {
            routerId: context.routerId,
            endpoint: parsed.endpoint,
            action: "dry_run",
            dryRun: true,
            changes,
            compatibility,
            blob: preview,
          },
        };
      }

      const response = await client.writeBlob(parsed.endpoint, wire);
      return {
        content:
          `Wrote ${parsed.endpoint} on ${context.routerId}:\n${diff}\n` +
          `${banner}\n` +
          `Response: ${response || "(empty)"}\n` +
          "The pre-write blob was snapshotted — undo with rollback_change using this call's journal ID.",
        structuredContent: {
          routerId: context.routerId,
          endpoint: parsed.endpoint,
          action: "written",
          dryRun: false,
          changes,
          compatibility,
          response,
        },
      };
    } catch (err) {
      throw toolError(err, context, "write_swos_blob");
    }
  },
};

export const swosTools: ToolDefinition[] = [
  listSwosEndpointsTool,
  getSwosStatusTool,
  getSwosEndpointTool,
  writeSwosBlobTool,
];

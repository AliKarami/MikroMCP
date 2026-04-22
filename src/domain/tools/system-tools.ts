// ---------------------------------------------------------------------------
// MikroMCP - System information tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { enrichError } from "../errors/error-enricher.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("system-tools");

const SECTION_VALUES = ["resource", "identity", "license", "routerboard", "health", "clock", "all"] as const;
type Section = (typeof SECTION_VALUES)[number];

const ALL_SECTIONS: Exclude<Section, "all">[] = [
  "resource",
  "identity",
  "license",
  "routerboard",
  "health",
  "clock",
];

const SECTION_PATHS: Record<Exclude<Section, "all">, string> = {
  resource: "system/resource",
  identity: "system/identity",
  license: "system/license",
  routerboard: "system/routerboard",
  health: "system/health",
  clock: "system/clock",
};

const inputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  sections: z.array(z.enum(SECTION_VALUES))
    .default(["all"])
    .describe("Which system information sections to include"),
}).strict();

async function fetchSection(
  context: ToolContext,
  section: Exclude<Section, "all">,
): Promise<Record<string, unknown>> {
  const path = SECTION_PATHS[section];
  const result = await context.routerClient.get<Record<string, string>>(path);
  // Single-object resources return an array with one element
  if (Array.isArray(result) && result.length > 0) {
    return result[0] as Record<string, unknown>;
  }
  return (result as unknown as Record<string, unknown>) ?? {};
}

function buildTextSummary(sections: Record<string, Record<string, unknown>>): string {
  const lines: string[] = [];

  if (sections.resource) {
    const r = sections.resource as Record<string, string>;
    lines.push(`System Resource:`);
    if (r["board-name"]) lines.push(`  Board: ${r["board-name"]}`);
    if (r.version) lines.push(`  RouterOS: ${r.version}`);
    if (r.architecture) lines.push(`  Architecture: ${r.architecture}`);
    if (r.uptime) lines.push(`  Uptime: ${r.uptime}`);
    if (r["cpu-load"]) lines.push(`  CPU Load: ${r["cpu-load"]}%`);
    if (r["free-memory"] && r["total-memory"]) {
      lines.push(`  Memory: ${r["free-memory"]} free / ${r["total-memory"]} total`);
    }
    if (r["free-hdd-space"] && r["total-hdd-space"]) {
      lines.push(`  Disk: ${r["free-hdd-space"]} free / ${r["total-hdd-space"]} total`);
    }
  }

  if (sections.identity) {
    const id = sections.identity as Record<string, string>;
    if (id.name) lines.push(`Identity: ${id.name}`);
  }

  if (sections.license) {
    const lic = sections.license as Record<string, string>;
    lines.push(`License:`);
    if (lic.level) lines.push(`  Level: ${lic.level}`);
    if (lic["software-id"]) lines.push(`  Software ID: ${lic["software-id"]}`);
  }

  if (sections.routerboard) {
    const rb = sections.routerboard as Record<string, string>;
    lines.push(`RouterBOARD:`);
    if (rb.model) lines.push(`  Model: ${rb.model}`);
    if (rb["serial-number"]) lines.push(`  Serial: ${rb["serial-number"]}`);
    if (rb["firmware-type"]) lines.push(`  Firmware: ${rb["firmware-type"]}`);
    if (rb["current-firmware"]) lines.push(`  Current FW: ${rb["current-firmware"]}`);
  }

  if (sections.health) {
    const h = sections.health as Record<string, string>;
    lines.push(`Health:`);
    for (const [key, value] of Object.entries(h)) {
      if (key !== ".id") lines.push(`  ${key}: ${value}`);
    }
  }

  if (sections.clock) {
    const c = sections.clock as Record<string, string>;
    lines.push(`Clock:`);
    if (c.date) lines.push(`  Date: ${c.date}`);
    if (c.time) lines.push(`  Time: ${c.time}`);
    if (c["time-zone-name"]) lines.push(`  Timezone: ${c["time-zone-name"]}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No system information retrieved.";
}

const getSystemStatusTool: ToolDefinition = {
  name: "get_system_status",
  title: "Get System Status",
  description:
    "Retrieve system status information from a MikroTik router including resource usage, identity, license, routerboard details, health sensors, and clock.",
  inputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = inputSchema.parse(params);
    const requestedSections = parsed.sections.includes("all")
      ? ALL_SECTIONS
      : (parsed.sections.filter((s): s is Exclude<Section, "all"> => s !== "all"));

    log.info({ routerId: context.routerId, sections: requestedSections }, "Fetching system status");

    try {
      const results: Record<string, Record<string, unknown>> = {};

      for (const section of requestedSections) {
        try {
          results[section] = await fetchSection(context, section);
        } catch (err) {
          log.warn({ section, err }, "Failed to fetch section, skipping");
          results[section] = { _error: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      const content = buildTextSummary(results);

      return {
        content,
        structuredContent: {
          routerId: context.routerId,
          sections: results,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "get_system_status" });
    }
  },
};

export const systemTools: ToolDefinition[] = [getSystemStatusTool];

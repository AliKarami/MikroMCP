import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("wifi-tools");

function wifiPath(rosVersion: string): string {
  return rosVersion.startsWith("7") ? "interface/wifi" : "interface/wireless";
}

function wifiRegistrationPath(rosVersion: string): string {
  return rosVersion.startsWith("7")
    ? "interface/wifi/registration-table"
    : "interface/wireless/registration-table";
}

const listWifiInputSchema = z
  .object({
    routerId,
    limit,
    offset,
  })
  .strict();

const listWifiTool: ToolDefinition = {
  name: "list_wifi_interfaces",
  title: "List WiFi Interfaces",
  description:
    "List WiFi/wireless interfaces on a MikroTik router. Uses /interface/wifi on ROS 7.x, /interface/wireless on older versions.",
  inputSchema: listWifiInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listWifiInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing WiFi interfaces");
    try {
      const path = wifiPath(context.routerConfig.rosVersion);
      const interfaces = await context.routerClient.get<RouterOSRecord>(path, {
        limit: undefined,
        offset: undefined,
      });
      const { items: paginated, total, hasMore } = paginate(interfaces, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "WiFi interfaces",
          context.routerId,
          paginated,
          total,
          parsed.offset,
          (i) => compactFields(i, ["name", "master-interface", "mac-address", "disabled", "comment"]),
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
      throw toolError(err, context, "list_wifi_interfaces");
    }
  },
};

const listWifiClientsInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Filter by WiFi interface name"),
    limit,
    offset,
  })
  .strict();

const listWifiClientsTool: ToolDefinition = {
  name: "list_wifi_clients",
  title: "List WiFi Clients",
  description:
    "List currently connected WiFi clients (stations) with signal strength and transfer rates.",
  inputSchema: listWifiClientsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listWifiClientsInputSchema.parse(params);
    log.info({ routerId: context.routerId, interface: parsed.interface }, "Listing WiFi clients");
    try {
      const path = wifiRegistrationPath(context.routerConfig.rosVersion);
      const filter = parsed.interface ? { interface: parsed.interface } : undefined;
      const allClients = await context.routerClient.get<RouterOSRecord>(path, { filter });

      const { items: clients, total, hasMore } = paginate(allClients, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "WiFi clients",
          context.routerId,
          clients,
          total,
          parsed.offset,
          (c) => compactFields(c, ["interface", "mac-address", "signal", "tx-rate", "rx-rate", "uptime"]),
        ),
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
      throw toolError(err, context, "list_wifi_clients");
    }
  },
};

const manageWifiInputSchema = z
  .object({
    routerId,
    name: z.string().describe("WiFi interface name (e.g. wifi1, wlan1)"),
    disabled: z.boolean().optional().describe("Set to true to disable, false to enable"),
    ssid: z.string().max(32).optional().describe("New SSID to set"),
    dryRun,
  })
  .strict();

const manageWifiTool: ToolDefinition = {
  name: "manage_wifi_interface",
  title: "Manage WiFi Interface",
  description:
    "Enable, disable, or update SSID settings on a WiFi interface. At least one of disabled or ssid must be provided.",
  inputSchema: manageWifiInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageWifiInputSchema.parse(params);

    if (parsed.disabled === undefined && parsed.ssid === undefined) {
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "NO_CHANGES_SPECIFIED",
        message: "At least one of 'disabled' or 'ssid' must be provided.",
        recoverability: {
          retryable: false,
          suggestedAction: "Provide disabled and/or ssid to change.",
        },
      });
    }

    log.info({ routerId: context.routerId, name: parsed.name }, "Managing WiFi interface");
    try {
      const path = wifiPath(context.routerConfig.rosVersion);
      const existing = await context.routerClient.get<RouterOSRecord>(path, {
        filter: { name: parsed.name },
      });

      if (existing.length === 0) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "WIFI_INTERFACE_NOT_FOUND",
          message: `WiFi interface "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the interface name with list_wifi_interfaces.",
          },
        });
      }

      const rec = existing[0] as Record<string, string>;
      const changes: Record<string, string> = {};
      const diff: Array<{ property: string; before: string | null; after: string | null }> = [];

      if (parsed.disabled !== undefined) {
        const desired = parsed.disabled ? "true" : "false";
        if (rec.disabled !== desired) {
          changes.disabled = desired;
          diff.push({ property: "disabled", before: rec.disabled ?? null, after: desired });
        }
      }
      if (parsed.ssid !== undefined && rec.ssid !== parsed.ssid) {
        changes.ssid = parsed.ssid;
        diff.push({ property: "ssid", before: rec.ssid ?? null, after: parsed.ssid });
      }

      if (diff.length === 0) {
        return {
          content: `WiFi interface "${parsed.name}" already has the requested configuration. No changes made.`,
          structuredContent: { action: "no_change", interface: existing[0] },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would update WiFi interface "${parsed.name}": ${diff.map((d) => `${d.property}: ${d.before} → ${d.after}`).join(", ")}.`,
          structuredContent: { action: "dry_run", diff },
        };
      }

      await context.routerClient.update(path, rec[".id"], changes);
      log.info({ name: parsed.name, changes }, "WiFi interface updated");
      return {
        content: `Updated WiFi interface "${parsed.name}": ${diff.map((d) => `${d.property}: ${d.before} → ${d.after}`).join(", ")}.`,
        structuredContent: { action: "updated", name: parsed.name, changes: diff },
      };
    } catch (err) {
      throw toolError(err, context, "manage_wifi_interface");
    }
  },
};

export const wifiTools: ToolDefinition[] = [listWifiTool, listWifiClientsTool, manageWifiTool];

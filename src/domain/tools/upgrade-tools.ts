import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("upgrade-tools");

const getUpgradeStatusInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
  })
  .strict();

const getUpgradeStatusTool: ToolDefinition = {
  name: "get_upgrade_status",
  title: "Get Upgrade Status",
  description:
    "Read the current RouterOS package upgrade status and routerboard firmware versions. Shows installed version, latest available version, update channel, and firmware upgrade availability.",
  inputSchema: getUpgradeStatusInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getUpgradeStatusInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Getting upgrade status");

    try {
      const [updateResults, routerboardResults] = await Promise.all([
        context.routerClient.get<RouterOSRecord>("system/package/update"),
        context.routerClient.get<RouterOSRecord>("system/routerboard"),
      ]);

      const update = (updateResults[0] ?? {}) as Record<string, string>;
      const routerboard =
        routerboardResults.length > 0
          ? (routerboardResults[0] as Record<string, string>)
          : null;

      return {
        content: `Upgrade status on ${parsed.routerId}: installed=${update["installed-version"] ?? "?"} latest=${update["latest-version"] ?? "?"} (${update.status ?? "unknown"})`,
        structuredContent: {
          routerId: parsed.routerId,
          channel: update.channel ?? null,
          installedVersion: update["installed-version"] ?? null,
          latestVersion: update["latest-version"] ?? null,
          status: update.status ?? null,
          routerboard: routerboard
            ? {
                model: routerboard.model ?? null,
                currentFirmware: routerboard["current-firmware"] ?? null,
                upgradeFirmware: routerboard["upgrade-firmware"] ?? null,
                factoryFirmware: routerboard["factory-firmware"] ?? null,
              }
            : null,
        },
      };
    } catch (err) {
      throw toolError(err, context, "get_upgrade_status");
    }
  },
};

const manageUpgradeInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z
      .enum(["check", "install"])
      .describe(
        "check — trigger a check for available updates; install — download and install the latest update (triggers reboot)",
      ),
    dryRun: z.boolean().default(false).describe("Preview the action without executing"),
  })
  .strict();

const manageUpgradeTool: ToolDefinition = {
  name: "manage_upgrade",
  title: "Manage Upgrade",
  description:
    "Trigger a RouterOS package update check or install. 'check' queries the update server for new packages. 'install' downloads and applies the update — the router will reboot automatically. Supports dry-run.",
  inputSchema: manageUpgradeInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageUpgradeInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action }, "Managing upgrade");

    try {
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would execute '${parsed.action}' on ${parsed.routerId}.`,
          structuredContent: {
            action: "dry_run",
            requestedAction: parsed.action,
            routerId: parsed.routerId,
          },
        };
      }

      if (parsed.action === "check") {
        await context.routerClient.execute("system/package/update/check-for-updates");
        log.info({ routerId: context.routerId }, "Update check triggered");
        return {
          content: `Update check triggered on ${parsed.routerId}.`,
          structuredContent: { action: "check_triggered", routerId: parsed.routerId },
        };
      }

      await context.routerClient.execute("system/package/update/install");
      log.info({ routerId: context.routerId }, "Package install triggered");
      return {
        content: `Package install triggered on ${parsed.routerId}. Router will reboot automatically.`,
        structuredContent: { action: "install_triggered", routerId: parsed.routerId },
      };
    } catch (err) {
      throw toolError(err, context, "manage_upgrade");
    }
  },
};

export const upgradeTools: ToolDefinition[] = [getUpgradeStatusTool, manageUpgradeTool];

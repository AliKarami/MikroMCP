import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate } from "./pagination.js";

const log = createLogger("ip-pool-tools");

const listIpPoolsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by pool name (substring match)"),
    limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of pools to return"),
    offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  })
  .strict();

const listIpPoolsTool: ToolDefinition = {
  name: "list_ip_pools",
  title: "List IP Pools",
  description: "List IP address pools on a MikroTik router. Supports filtering by name and pagination.",
  inputSchema: listIpPoolsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listIpPoolsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing IP pools");
    try {
      const allPools = await context.routerClient.get<RouterOSRecord>("ip/pool", {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allPools as Record<string, string>[];
      if (parsed.name) {
        filtered = filtered.filter((p) => (p.name ?? "").includes(parsed.name!));
      }

      const { items: pools, total, hasMore } = paginate(filtered, parsed.offset, parsed.limit);

      return {
        content: `IP pools on ${context.routerId}: ${total} total, showing ${pools.length} (offset ${parsed.offset})`,
        structuredContent: {
          routerId: context.routerId,
          pools,
          total,
          hasMore,
          offset: parsed.offset,
          limit: parsed.limit,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_ip_pools");
    }
  },
};

const manageIpPoolInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Pool name — idempotency key"),
    ranges: z
      .string()
      .optional()
      .describe("IP range (e.g. '192.168.1.100-192.168.1.200'; required for add)"),
    nextPool: z.string().optional().describe("Next pool name for overflow"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageIpPoolTool: ToolDefinition = {
  name: "manage_ip_pool",
  title: "Manage IP Pool",
  description:
    "Add or remove an IP address pool. Idempotent by name: add returns already_exists if a pool with the same name and ranges already exists.",
  inputSchema: manageIpPoolInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/pool"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageIpPoolInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing IP pool");
    try {
      const allPools = await context.routerClient.get<RouterOSRecord>("ip/pool", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allPools as Record<string, string>[]).find((p) => p.name === parsed.name);

      if (parsed.action === "add") {
        if (!parsed.ranges) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "IP_POOL_RANGES_REQUIRED",
            message: "ranges is required when adding an IP pool.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the IP range (e.g. '192.168.1.100-192.168.1.200').",
            },
          });
        }

        if (existing) {
          if (existing.ranges === parsed.ranges) {
            return {
              content: `IP pool "${parsed.name}" already exists with the same ranges. No changes made.`,
              structuredContent: { action: "already_exists", pool: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "IP_POOL_CONFLICT",
            message: `IP pool "${parsed.name}" exists with different ranges.`,
            details: { existing: existing.ranges, requested: parsed.ranges },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing pool first or use a different name.",
              alternativeTools: ["manage_ip_pool"],
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "ranges", before: null, after: parsed.ranges },
            ...(parsed.nextPool ? [{ property: "next-pool", before: null, after: parsed.nextPool }] : []),
          ];
          return {
            content: `Dry run: Would add IP pool "${parsed.name}" with ranges ${parsed.ranges}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = { name: parsed.name, ranges: parsed.ranges };
        if (parsed.nextPool) body["next-pool"] = parsed.nextPool;

        const created = await context.routerClient.create("ip/pool", body);
        log.info({ name: parsed.name, id: created[".id"] }, "IP pool added");
        return {
          content: `Added IP pool "${parsed.name}" with ranges ${parsed.ranges}.`,
          structuredContent: { action: "created", pool: created },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `IP pool "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove IP pool "${parsed.name}".`,
          structuredContent: { action: "dry_run", diff: [{ property: "name", before: parsed.name, after: null }] },
        };
      }
      await context.routerClient.remove("ip/pool", existing[".id"]);
      log.info({ name: parsed.name }, "IP pool removed");
      return {
        content: `Removed IP pool "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_ip_pool");
    }
  },
};

export const ipPoolTools: ToolDefinition[] = [listIpPoolsTool, manageIpPoolTool];

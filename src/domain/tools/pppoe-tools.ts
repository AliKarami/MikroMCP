import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { isTrue } from "../../adapter/response-parser.js";
import { dryRun, limit, offset, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

import { paginate, listContent, compactFields } from "./pagination.js";

const log = createLogger("pppoe-tools");

const PPPOE_PATH = "interface/pppoe-client";

const listPppoeClientsInputSchema = z
  .object({
    routerId,
    interface: z.string().optional().describe("Filter by parent interface name (exact match)"),
    status: z
      .enum(["connected", "disconnected", "all"])
      .default("all")
      .describe("Filter by running status"),
    limit,
    offset,
  })
  .strict();

function isRunning(record: Record<string, unknown>): boolean {
  return isTrue(record.running);
}

const listPppoeClientsTool: ToolDefinition = {
  name: "list_pppoe_clients",
  title: "List PPPoE Clients",
  description:
    "List PPPoE client interfaces on a MikroTik router. Shows name, parent interface, ISP username, and connection status.",
  inputSchema: listPppoeClientsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listPppoeClientsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing PPPoE clients");
    try {
      const allClients = await context.routerClient.get<RouterOSRecord>(PPPOE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      let filtered = allClients as Record<string, unknown>[];

      if (parsed.interface) {
        filtered = filtered.filter((c) => c.interface === parsed.interface);
      }

      if (parsed.status === "connected") {
        filtered = filtered.filter((c) => isRunning(c));
      } else if (parsed.status === "disconnected") {
        filtered = filtered.filter((c) => !isRunning(c));
      }

      const { items: clients, total, hasMore } = paginate(filtered, parsed.offset, parsed.limit);

      return {
        content: listContent(
          "PPPoE clients",
          context.routerId,
          clients,
          total,
          parsed.offset,
          (c) => compactFields(c, ["name", "interface", "status", "user", "disabled"]),
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
      throw toolError(err, context, "list_pppoe_clients");
    }
  },
};

const managePppoeClientInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    name: z.string().describe("PPPoE client interface name — idempotency key (e.g. pppoe-wan)"),
    interface: z.string().optional().describe("Parent interface (required for add)"),
    user: z.string().optional().describe("PPPoE username (required for add)"),
    password: z.string().optional().describe("PPPoE password (never logged)"),
    serviceName: z.string().optional().describe("PPPoE service name filter (leave empty to match any)"),
    addDefaultRoute: z.boolean().optional().describe("Add default route via PPPoE (yes/no)"),
    dialOnDemand: z.boolean().optional().describe("Dial on demand instead of always-on (yes/no)"),
    dryRun,
  })
  .strict();

const managePppoeClientTool: ToolDefinition = {
  name: "manage_pppoe_client",
  title: "Manage PPPoE Client",
  description:
    "Add, update, or remove a PPPoE client interface. Idempotent by name (already_exists on matching name+interface+user; CONFLICT on differing config; no_change when an update differs in nothing). Password is always written when provided since RouterOS does not return it on GET.",
  inputSchema: managePppoeClientInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: [PPPOE_PATH],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = managePppoeClientInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing PPPoE client");

    try {
      const allClients = await context.routerClient.get<RouterOSRecord>(PPPOE_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allClients as Record<string, string>[]).find((c) => c.name === parsed.name);

      if (parsed.action === "add") {
        if (!parsed.interface) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "PPPOE_CLIENT_INTERFACE_REQUIRED",
            message: "interface is required for action add.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the parent interface (e.g. ether1).",
              alternativeTools: [],
            },
          });
        }

        if (!parsed.user) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "PPPOE_CLIENT_USER_REQUIRED",
            message: "user is required for action add.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the PPPoE username.",
              alternativeTools: [],
            },
          });
        }

        if (existing) {
          const sameConfig =
            existing.interface === parsed.interface && existing.user === parsed.user;
          if (sameConfig) {
            return {
              content: `PPPoE client "${parsed.name}" already exists with the same configuration. No changes made.`,
              structuredContent: { action: "already_exists", client: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "PPPOE_CLIENT_CONFLICT",
            message: `PPPoE client "${parsed.name}" already exists with a different configuration.`,
            details: {
              existing: { interface: existing.interface, user: existing.user },
              requested: { interface: parsed.interface, user: parsed.user },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing client first or use action update.",
              alternativeTools: ["manage_pppoe_client"],
            },
          });
        }

        const diff: Array<{ property: string; before: null; after: string }> = [
          { property: "name", before: null, after: parsed.name },
          { property: "interface", before: null, after: parsed.interface },
          { property: "user", before: null, after: parsed.user },
        ];
        if (parsed.serviceName !== undefined) {
          diff.push({ property: "service-name", before: null, after: parsed.serviceName });
        }
        if (parsed.addDefaultRoute !== undefined) {
          diff.push({ property: "add-default-route", before: null, after: parsed.addDefaultRoute ? "yes" : "no" });
        }
        if (parsed.dialOnDemand !== undefined) {
          diff.push({ property: "dial-on-demand", before: null, after: parsed.dialOnDemand ? "yes" : "no" });
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create PPPoE client "${parsed.name}" on "${parsed.interface}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          interface: parsed.interface,
          user: parsed.user,
        };
        if (parsed.password !== undefined) body.password = parsed.password;
        if (parsed.serviceName !== undefined) body["service-name"] = parsed.serviceName;
        if (parsed.addDefaultRoute !== undefined) body["add-default-route"] = parsed.addDefaultRoute ? "yes" : "no";
        if (parsed.dialOnDemand !== undefined) body["dial-on-demand"] = parsed.dialOnDemand ? "yes" : "no";

        const created = await context.routerClient.create(PPPOE_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "PPPoE client created");
        return {
          content: `Created PPPoE client "${parsed.name}" on "${parsed.interface}".`,
          structuredContent: { action: "created", client: created },
        };
      }

      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "PPPOE_CLIENT_NOT_FOUND",
            message: `PPPoE client "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify with list_pppoe_clients.",
              alternativeTools: ["list_pppoe_clients"],
            },
          });
        }

        const updates: Record<string, string> = {};
        const diff: Array<{ property: string; before: string | null; after: string }> = [];

        if (parsed.interface !== undefined && existing.interface !== parsed.interface) {
          updates.interface = parsed.interface;
          diff.push({ property: "interface", before: existing.interface, after: parsed.interface });
        }
        if (parsed.user !== undefined && existing.user !== parsed.user) {
          updates.user = parsed.user;
          diff.push({ property: "user", before: existing.user, after: parsed.user });
        }
        if (parsed.serviceName !== undefined && existing["service-name"] !== parsed.serviceName) {
          updates["service-name"] = parsed.serviceName;
          diff.push({ property: "service-name", before: existing["service-name"] ?? null, after: parsed.serviceName });
        }
        if (parsed.addDefaultRoute !== undefined) {
          const desired = parsed.addDefaultRoute ? "yes" : "no";
          if (existing["add-default-route"] !== desired) {
            updates["add-default-route"] = desired;
            diff.push({ property: "add-default-route", before: existing["add-default-route"] ?? null, after: desired });
          }
        }
        if (parsed.dialOnDemand !== undefined) {
          const desired = parsed.dialOnDemand ? "yes" : "no";
          if (existing["dial-on-demand"] !== desired) {
            updates["dial-on-demand"] = desired;
            diff.push({ property: "dial-on-demand", before: existing["dial-on-demand"] ?? null, after: desired });
          }
        }

        // RouterOS does not expose password in GET — always write it when provided
        if (parsed.password !== undefined) {
          updates.password = parsed.password;
        }

        const hasUpdates = Object.keys(updates).length > 0;

        if (!hasUpdates) {
          return {
            content: `PPPoE client "${parsed.name}" already matches the requested configuration. No changes made.`,
            structuredContent: { action: "no_change", client: existing },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update PPPoE client "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(PPPOE_PATH, existing[".id"], updates);
        log.info({ name: parsed.name }, "PPPoE client updated");
        return {
          content: `Updated PPPoE client "${parsed.name}".`,
          structuredContent: { action: "updated", name: parsed.name, diff },
        };
      }

      // remove
      if (!existing) {
        return {
          content: `PPPoE client "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove PPPoE client "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }

      await context.routerClient.remove(PPPOE_PATH, existing[".id"]);
      log.info({ name: parsed.name }, "PPPoE client removed");
      return {
        content: `Removed PPPoE client "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_pppoe_client");
    }
  },
};

export const pppoeTools: ToolDefinition[] = [listPppoeClientsTool, managePppoeClientTool];

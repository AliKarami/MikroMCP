import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("vrrp-tools");

const listVrrpInstancesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    interface: z
      .string()
      .optional()
      .describe("Filter by master interface name (exact match)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of instances to return"),
  })
  .strict();

const listVrrpInstancesTool: ToolDefinition = {
  name: "list_vrrp_instances",
  title: "List VRRP Instances",
  description: "List VRRP instances on a MikroTik router.",
  inputSchema: listVrrpInstancesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listVrrpInstancesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing VRRP instances");
    try {
      const allInstances = await context.routerClient.get<RouterOSRecord>("interface/vrrp", {
        limit: undefined,
        offset: undefined,
      });

      const filtered = parsed.interface
        ? (allInstances as Record<string, string>[]).filter(
            (inst) => inst.interface === parsed.interface,
          )
        : (allInstances as Record<string, string>[]);
      const instances = filtered.slice(0, parsed.limit);

      return {
        content: `VRRP instances on ${context.routerId}: ${instances.length} returned (${allInstances.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          instances,
          total: allInstances.length,
          returned: instances.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_vrrp_instances" });
    }
  },
};

const manageVrrpInstanceInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "remove", "enable", "disable"]).describe("Action to perform"),
    name: z.string().describe("VRRP interface name — idempotency key"),
    interface: z.string().optional().describe("Master interface (required for add)"),
    vrid: z.number().int().min(1).max(255).optional().describe("Virtual router ID (required for add)"),
    priority: z
      .number()
      .int()
      .min(1)
      .max(254)
      .default(100)
      .describe("Router priority (1–254)"),
    interval: z.number().int().min(1).optional().describe("Advertisement interval in seconds"),
    version: z.enum(["2", "3"]).default("3").describe("VRRP protocol version"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageVrrpInstanceTool: ToolDefinition = {
  name: "manage_vrrp_instance",
  title: "Manage VRRP Instance",
  description:
    "Add, remove, enable, or disable a VRRP instance. Idempotent by name: add returns already_exists if an instance with the same name, interface, and VRID already exists.",
  inputSchema: manageVrrpInstanceInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/vrrp"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageVrrpInstanceInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing VRRP instance",
    );
    try {
      const allInstances = await context.routerClient.get<RouterOSRecord>("interface/vrrp", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allInstances as Record<string, string>[]).find(
        (inst) => inst.name === parsed.name,
      );

      if (parsed.action === "add") {
        if (!parsed.interface) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "VRRP_INTERFACE_REQUIRED",
            message: "interface is required when adding a VRRP instance.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the master interface name.",
            },
          });
        }

        if (parsed.vrid === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "VRRP_VRID_REQUIRED",
            message: "vrid is required when adding a VRRP instance.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a VRID between 1 and 255.",
            },
          });
        }

        if (existing) {
          if (existing.interface === parsed.interface && existing.vrid === String(parsed.vrid)) {
            return {
              content: `VRRP instance "${parsed.name}" already exists with the same interface and VRID. No changes made.`,
              structuredContent: { action: "already_exists", instance: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "VRRP_CONFLICT",
            message: `VRRP instance "${parsed.name}" exists with different interface or VRID.`,
            details: {
              existing: { interface: existing.interface, vrid: existing.vrid },
              requested: { interface: parsed.interface, vrid: String(parsed.vrid) },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing instance first or use a different name.",
              alternativeTools: ["manage_vrrp_instance"],
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "interface", before: null, after: parsed.interface },
            { property: "vrid", before: null, after: String(parsed.vrid) },
            { property: "priority", before: null, after: String(parsed.priority) },
            { property: "version", before: null, after: parsed.version },
            ...(parsed.interval
              ? [{ property: "interval", before: null, after: String(parsed.interval) }]
              : []),
            ...(parsed.comment ? [{ property: "comment", before: null, after: parsed.comment }] : []),
          ];
          return {
            content: `Dry run: Would add VRRP instance "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          interface: parsed.interface,
          vrid: String(parsed.vrid),
          priority: String(parsed.priority),
          version: parsed.version,
        };
        if (parsed.interval) body.interval = String(parsed.interval);
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("interface/vrrp", body);
        log.info({ name: parsed.name, id: created[".id"] }, "VRRP instance added");
        return {
          content: `Added VRRP instance "${parsed.name}".`,
          structuredContent: { action: "created", instance: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `VRRP instance "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove VRRP instance "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("interface/vrrp", existing[".id"]);
        log.info({ name: parsed.name }, "VRRP instance removed");
        return {
          content: `Removed VRRP instance "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "VRRP_NOT_FOUND",
          message: `VRRP instance "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the instance name with list_vrrp_instances.",
            alternativeTools: ["list_vrrp_instances"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} VRRP instance "${parsed.name}".`,
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
      await context.routerClient.update("interface/vrrp", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "VRRP instance updated");
      return {
        content: `VRRP instance "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_vrrp_instance" });
    }
  },
};

export const vrrpTools: ToolDefinition[] = [listVrrpInstancesTool, manageVrrpInstanceTool];

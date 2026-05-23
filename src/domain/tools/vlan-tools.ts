import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("vlan-tools");

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

const manageVlanInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z
      .enum(["add", "remove", "enable", "disable"])
      .describe("Action to perform"),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(15)
      .describe("VLAN interface name — idempotency key (alphanumeric, hyphens, underscores, max 15 chars)"),
    vlanId: z.number().int().min(1).max(4094).optional().describe("VLAN ID (1-4094; required for add)"),
    parentInterface: z.string().optional().describe("Parent interface name (e.g., ether1, bridge1; required for add)"),
    mtu: z.number().int().min(68).max(9000).default(1500).describe("MTU size (add only)"),
    disabled: z.boolean().default(false).describe("Whether to create the VLAN disabled (add only)"),
    comment: z.string().max(255).optional().describe("Optional comment (add only)"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageVlanTool: ToolDefinition = {
  name: "manage_vlan",
  title: "Manage VLAN Interface",
  description:
    "Add, remove, enable, or disable a VLAN interface. Idempotent by name: add returns already_exists when a VLAN with matching name, vlan-id, and parent interface exists. Supports dry-run mode.",
  inputSchema: manageVlanInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["interface/vlan"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageVlanInputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing VLAN");

    try {
      const allVlans = await context.routerClient.get<RouterOSRecord>("interface/vlan", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allVlans as Record<string, string>[]).find((v) => v.name === parsed.name);

      if (parsed.action === "add") {
        if (parsed.vlanId === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "VLAN_ID_REQUIRED",
            message: "vlanId is required when adding a VLAN.",
            details: { name: parsed.name },
            recoverability: { retryable: false, suggestedAction: "Provide vlanId (1-4094)." },
          });
        }
        if (!parsed.parentInterface) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "VLAN_PARENT_REQUIRED",
            message: "parentInterface is required when adding a VLAN.",
            details: { name: parsed.name },
            recoverability: { retryable: false, suggestedAction: "Provide the parent interface name." },
          });
        }

        if (existing) {
          if (
            existing["vlan-id"] === String(parsed.vlanId) &&
            existing.interface === parsed.parentInterface
          ) {
            log.info({ name: parsed.name }, "VLAN already exists with matching config");
            return {
              content: `VLAN "${parsed.name}" already exists with VLAN ID ${parsed.vlanId} on ${parsed.parentInterface}. No changes made.`,
              structuredContent: { action: "already_exists", vlan: existing },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "VLAN_NAME_CONFLICT",
            message: `VLAN "${parsed.name}" already exists but with different configuration (vlan-id=${existing["vlan-id"]}, interface=${existing.interface}).`,
            details: {
              existing: { vlanId: existing["vlan-id"], interface: existing.interface },
              requested: { vlanId: parsed.vlanId, interface: parsed.parentInterface },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Use a different name or remove the existing VLAN first.",
              alternativeTools: ["manage_vlan"],
            },
          });
        }

        if (parsed.dryRun) {
          const diff = [
            { property: "name", before: null, after: parsed.name },
            { property: "vlan-id", before: null, after: String(parsed.vlanId) },
            { property: "interface", before: null, after: parsed.parentInterface },
            { property: "mtu", before: null, after: String(parsed.mtu) },
            { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
            ...(comment ? [{ property: "comment", before: null, after: comment }] : []),
          ];
          return {
            content: `Dry run: Would create VLAN "${parsed.name}" (ID ${parsed.vlanId}) on ${parsed.parentInterface} with MTU ${parsed.mtu}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          "vlan-id": String(parsed.vlanId),
          interface: parsed.parentInterface,
          mtu: String(parsed.mtu),
          disabled: parsed.disabled ? "true" : "false",
        };
        if (comment) body.comment = comment;

        const created = await context.routerClient.create("interface/vlan", body);
        log.info({ name: parsed.name, id: created[".id"] }, "VLAN created");
        return {
          content: `Created VLAN "${parsed.name}" (ID ${parsed.vlanId}) on ${parsed.parentInterface} with MTU ${parsed.mtu}.`,
          structuredContent: { action: "created", vlan: created },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `VLAN "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove VLAN "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff: [{ property: "name", before: parsed.name, after: null }] },
          };
        }
        await context.routerClient.remove("interface/vlan", existing[".id"]);
        log.info({ name: parsed.name }, "VLAN removed");
        return {
          content: `Removed VLAN "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "VLAN_NOT_FOUND",
          message: `VLAN "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the VLAN name with list_interfaces.",
            alternativeTools: ["list_interfaces"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} VLAN "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "disabled", before: existing.disabled, after: parsed.action === "disable" ? "true" : "false" }],
          },
        };
      }

      const disabledValue = parsed.action === "disable" ? "true" : "false";
      await context.routerClient.update("interface/vlan", existing[".id"], { disabled: disabledValue });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "VLAN updated");
      return {
        content: `VLAN "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_vlan" });
    }
  },
};

export const vlanTools: ToolDefinition[] = [manageVlanTool];

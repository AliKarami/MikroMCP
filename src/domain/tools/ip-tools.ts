// ---------------------------------------------------------------------------
// MikroMCP - IP address management tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("ip-tools");

const inputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  action: z.enum(["add", "update", "remove"])
    .describe("Action to perform: add, update, or remove an IP address"),
  address: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/)
    .describe("IP address in CIDR notation (e.g., 192.168.1.1/24)"),
  interface: z.string()
    .describe("Interface to assign the IP address to"),
  network: z.string().optional()
    .describe("Network address (auto-calculated from address if omitted)"),
  comment: z.string().max(255).optional()
    .describe("Optional comment for the IP address entry"),
  disabled: z.boolean().default(false)
    .describe("Whether the IP address should be disabled"),
  dryRun: z.boolean().default(false)
    .describe("If true, validate and return planned changes without applying"),
}).strict();

function sanitizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  return comment.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Find an existing IP address record by address and interface.
 */
async function findExisting(
  context: ToolContext,
  address: string,
  iface: string,
): Promise<RouterOSRecord | undefined> {
  const results = await context.routerClient.get<RouterOSRecord>("ip/address", {
    filter: { address, interface: iface },
  });
  return results.length > 0 ? results[0] : undefined;
}

const manageIpAddressTool: ToolDefinition = {
  name: "manage_ip_address",
  title: "Manage IP Address",
  description:
    "Add, update, or remove an IP address on a MikroTik router interface. Performs idempotency checks for add operations and supports dry-run mode for all actions.",
  inputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = inputSchema.parse(params);
    const comment = sanitizeComment(parsed.comment);

    log.info(
      { routerId: context.routerId, action: parsed.action, address: parsed.address, interface: parsed.interface },
      "Managing IP address",
    );

    try {
      // 1. Idempotency check: find existing record
      const existing = await findExisting(context, parsed.address, parsed.interface);

      // -----------------------------------------------------------------------
      // ADD
      // -----------------------------------------------------------------------
      if (parsed.action === "add") {
        if (existing) {
          const rec = existing as Record<string, string>;
          const sameDisabled = rec.disabled === (parsed.disabled ? "true" : "false");
          const sameComment = (rec.comment ?? "") === (comment ?? "");
          const sameNetwork = !parsed.network || rec.network === parsed.network;

          if (sameDisabled && sameComment && sameNetwork) {
            return {
              content: `IP address ${parsed.address} on ${parsed.interface} already exists with matching configuration. No changes made.`,
              structuredContent: {
                action: "already_exists",
                address: existing,
              },
            };
          }

          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "IP_ADDRESS_CONFLICT",
            message: `IP address ${parsed.address} already exists on ${parsed.interface} but with different configuration.`,
            details: {
              existing: {
                disabled: rec.disabled,
                comment: rec.comment,
                network: rec.network,
              },
              requested: {
                disabled: parsed.disabled ? "true" : "false",
                comment: comment ?? "",
                network: parsed.network,
              },
            },
            recoverability: {
              retryable: false,
              suggestedAction: "Use the 'update' action to modify the existing address, or remove it first.",
              alternativeTools: ["manage_ip_address with action=update"],
            },
          });
        }

        // Dry run for add
        if (parsed.dryRun) {
          const diff = [
            { property: "address", before: null, after: parsed.address },
            { property: "interface", before: null, after: parsed.interface },
            { property: "disabled", before: null, after: parsed.disabled ? "true" : "false" },
            ...(comment ? [{ property: "comment", before: null, after: comment }] : []),
            ...(parsed.network ? [{ property: "network", before: null, after: parsed.network }] : []),
          ];

          return {
            content: `Dry run: Would add IP address ${parsed.address} on ${parsed.interface}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        // Create
        const body: Record<string, string> = {
          address: parsed.address,
          interface: parsed.interface,
          disabled: parsed.disabled ? "true" : "false",
        };
        if (comment) body.comment = comment;
        if (parsed.network) body.network = parsed.network;

        const created = await context.routerClient.create("ip/address", body);

        log.info({ address: parsed.address, id: created[".id"] }, "IP address added");

        return {
          content: `Added IP address ${parsed.address} on ${parsed.interface}.`,
          structuredContent: { action: "created", address: created },
        };
      }

      // -----------------------------------------------------------------------
      // UPDATE
      // -----------------------------------------------------------------------
      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "IP_ADDRESS_NOT_FOUND",
            message: `IP address ${parsed.address} not found on interface ${parsed.interface}.`,
            details: { address: parsed.address, interface: parsed.interface },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the address and interface, or use 'add' action to create it.",
              alternativeTools: ["manage_ip_address with action=add"],
            },
          });
        }

        const rec = existing as Record<string, string>;
        const id = rec[".id"];

        // Compute changes
        const changes: Record<string, string> = {};
        const diff: Array<{ property: string; before: string | null; after: string | null }> = [];

        const disabledStr = parsed.disabled ? "true" : "false";
        if (rec.disabled !== disabledStr) {
          changes.disabled = disabledStr;
          diff.push({ property: "disabled", before: rec.disabled ?? null, after: disabledStr });
        }
        if (comment !== undefined && (rec.comment ?? "") !== comment) {
          changes.comment = comment;
          diff.push({ property: "comment", before: rec.comment ?? null, after: comment });
        }
        if (parsed.network && rec.network !== parsed.network) {
          changes.network = parsed.network;
          diff.push({ property: "network", before: rec.network ?? null, after: parsed.network });
        }

        if (diff.length === 0) {
          return {
            content: `IP address ${parsed.address} on ${parsed.interface} already has the requested configuration. No changes made.`,
            structuredContent: { action: "no_change", address: existing },
          };
        }

        // Dry run for update
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update IP address ${parsed.address} on ${parsed.interface}: ${diff.map((d) => `${d.property}: ${d.before} -> ${d.after}`).join(", ")}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update("ip/address", id, changes);

        log.info({ address: parsed.address, id, changes }, "IP address updated");

        return {
          content: `Updated IP address ${parsed.address} on ${parsed.interface}: ${diff.map((d) => `${d.property}: ${d.before} -> ${d.after}`).join(", ")}.`,
          structuredContent: { action: "updated", id, changes: diff },
        };
      }

      // -----------------------------------------------------------------------
      // REMOVE
      // -----------------------------------------------------------------------
      if (parsed.action === "remove") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "IP_ADDRESS_NOT_FOUND",
            message: `IP address ${parsed.address} not found on interface ${parsed.interface}. Cannot remove.`,
            details: { address: parsed.address, interface: parsed.interface },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the address and interface exist on the router.",
            },
          });
        }

        const rec = existing as Record<string, string>;
        const id = rec[".id"];

        // Dry run for remove
        if (parsed.dryRun) {
          const diff = [
            { property: "address", before: parsed.address, after: null },
            { property: "interface", before: parsed.interface, after: null },
          ];

          return {
            content: `Dry run: Would remove IP address ${parsed.address} from ${parsed.interface}.`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.remove("ip/address", id);

        log.info({ address: parsed.address, id }, "IP address removed");

        return {
          content: `Removed IP address ${parsed.address} from ${parsed.interface}.`,
          structuredContent: { action: "removed", id, address: parsed.address, interface: parsed.interface },
        };
      }

      // Should be unreachable due to zod enum validation
      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: {
          retryable: false,
          suggestedAction: "Use one of: add, update, remove.",
        },
      });
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_ip_address" });
    }
  },
};

export const ipTools: ToolDefinition[] = [manageIpAddressTool];

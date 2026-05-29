import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("address-list-tools");

const ADDRESS_LIST_PATH = "ip/firewall/address-list";

const listAddressListInputSchema = z
  .object({
    routerId,
    list: z.string().optional().describe("Filter by address list name"),
    address: z.string().optional().describe("Filter by address (IP or CIDR)"),
  })
  .strict();

const listAddressListTool: ToolDefinition = {
  name: "list_address_list_entries",
  title: "List Address List Entries",
  description:
    "List firewall address list entries on a MikroTik router. Supports filtering by list name and address.",
  inputSchema: listAddressListInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listAddressListInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing address list entries");

    try {
      const filter: Record<string, string> = {};
      if (parsed.list !== undefined) filter.list = parsed.list;
      if (parsed.address !== undefined) filter.address = parsed.address;

      const entries = await context.routerClient.get<RouterOSRecord>(ADDRESS_LIST_PATH, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit: undefined,
        offset: undefined,
      });

      return {
        content: `Address list entries on ${context.routerId}: ${entries.length} entry(ies).`,
        structuredContent: { routerId: context.routerId, entries, total: entries.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_address_list_entries");
    }
  },
};

const manageAddressListInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    list: z.string().describe("Address list name"),
    address: z.string().describe("IP address or CIDR to add/remove"),
    comment: z.string().optional().describe("Optional comment for the entry"),
    timeout: z.string().optional().describe("Expiry timeout (e.g. 1d, 2h30m) — omit for permanent"),
    dryRun,
  })
  .strict();

const manageAddressListTool: ToolDefinition = {
  name: "manage_address_list_entry",
  title: "Manage Address List Entry",
  description:
    "Add or remove a firewall address list entry. Idempotent by list name + address. Supports dry-run mode.",
  inputSchema: manageAddressListInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["ip/firewall/address-list"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageAddressListInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, list: parsed.list },
      "Managing address list entry",
    );

    try {
      const existing = await context.routerClient.get<RouterOSRecord>(ADDRESS_LIST_PATH, {
        filter: { list: parsed.list, address: parsed.address },
      });
      const found = existing.length > 0 ? (existing[0] as Record<string, string>) : undefined;

      if (parsed.action === "add") {
        if (found) {
          return {
            content: `Address list entry "${parsed.address}" in list "${parsed.list}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", entry: found },
          };
        }

        const body: Record<string, string> = { list: parsed.list, address: parsed.address };
        if (parsed.comment !== undefined) body.comment = parsed.comment;
        if (parsed.timeout !== undefined) body.timeout = parsed.timeout;

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add "${parsed.address}" to address list "${parsed.list}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(ADDRESS_LIST_PATH, body);
        log.info(
          { list: parsed.list, address: parsed.address, id: created[".id"] },
          "Address list entry added",
        );

        return {
          content: `Added "${parsed.address}" to address list "${parsed.list}".`,
          structuredContent: { action: "created", entry: created },
        };
      }

      if (parsed.action === "remove") {
        if (!found) {
          return {
            content: `Address list entry "${parsed.address}" in list "${parsed.list}" does not exist. No changes made.`,
            structuredContent: {
              action: "already_removed",
              list: parsed.list,
              address: parsed.address,
            },
          };
        }

        const id = found[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove "${parsed.address}" from address list "${parsed.list}".`,
            structuredContent: {
              action: "dry_run",
              id,
              list: parsed.list,
              address: parsed.address,
            },
          };
        }

        await context.routerClient.remove(ADDRESS_LIST_PATH, id);
        log.info({ id, list: parsed.list, address: parsed.address }, "Address list entry removed");

        return {
          content: `Removed "${parsed.address}" from address list "${parsed.list}".`,
          structuredContent: { action: "removed", id, list: parsed.list, address: parsed.address },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: { retryable: false, suggestedAction: "Use one of: add, remove." },
      });
    } catch (err) {
      throw toolError(err, context, "manage_address_list_entry");
    }
  },
};

export const addressListTools: ToolDefinition[] = [listAddressListTool, manageAddressListTool];

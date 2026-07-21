import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("interface-list-tools");

const listInterfaceListsInputSchema = z
  .object({
    routerId,
    limit,
  })
  .strict();

const listInterfaceListsTool: ToolDefinition = {
  name: "list_interface_lists",
  title: "List Interface Lists",
  description: "List all interface lists defined on the router.",
  inputSchema: listInterfaceListsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listInterfaceListsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing interface lists");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("interface/list", {
        limit: undefined,
        offset: undefined,
      });
      const lists = (all as RouterOSRecord[]).slice(0, parsed.limit);
      return {
        content: listContent(
          "Interface lists",
          context.routerId,
          lists,
          all.length,
          0,
          (l) => compactFields(l, ["name", "include", "exclude", "comment"]),
        ),
        structuredContent: { routerId: context.routerId, lists, total: all.length, returned: lists.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_interface_lists");
    }
  },
};

const manageInterfaceListInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    name: z.string().describe("Interface list name — idempotency key"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageInterfaceListTool: ToolDefinition = {
  name: "manage_interface_list",
  title: "Manage Interface List",
  description:
    "Add or remove an interface list. Idempotent by name. Removing a list that has members is blocked by RouterOS — the error is surfaced as-is.",
  inputSchema: manageInterfaceListInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageInterfaceListInputSchema.parse(params);
    log.info({ routerId: context.routerId, action: parsed.action, name: parsed.name }, "Managing interface list");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("interface/list", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find((l) => l.name === parsed.name);

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `Interface list "${parsed.name}" already exists. No changes made.`,
            structuredContent: { action: "already_exists", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would create interface list "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: null, after: parsed.name }],
            },
          };
        }
        const body: Record<string, string> = { name: parsed.name };
        if (parsed.comment) body.comment = parsed.comment;
        const created = await context.routerClient.create("interface/list", body);
        log.info({ name: parsed.name, id: created[".id"] }, "Interface list created");
        return {
          content: `Created interface list "${parsed.name}".`,
          structuredContent: { action: "created", name: parsed.name, id: created[".id"] },
        };
      }

      if (!existing) {
        return {
          content: `Interface list "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove interface list "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/list", existing[".id"]);
      log.info({ name: parsed.name }, "Interface list removed");
      return {
        content: `Removed interface list "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_interface_list");
    }
  },
};

const manageInterfaceListMemberInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "remove"]).describe("Action to perform"),
    list: z.string().describe("Interface list name — part of composite idempotency key"),
    interface: z.string().describe("Interface name to add/remove — part of composite idempotency key"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageInterfaceListMemberTool: ToolDefinition = {
  name: "manage_interface_list_member",
  title: "Manage Interface List Member",
  description:
    "Add or remove an interface from an interface list. Idempotent by list+interface composite key. add returns already_exists if the membership exists. remove returns not_found gracefully.",
  inputSchema: manageInterfaceListMemberInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageInterfaceListMemberInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, list: parsed.list, interface: parsed.interface },
      "Managing interface list member",
    );
    try {
      const all = await context.routerClient.get<RouterOSRecord>("interface/list/member", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find(
        (m) => m.list === parsed.list && m.interface === parsed.interface,
      );

      if (parsed.action === "add") {
        if (existing) {
          return {
            content: `Interface "${parsed.interface}" is already a member of list "${parsed.list}". No changes made.`,
            structuredContent: { action: "already_exists", list: parsed.list, interface: parsed.interface },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add "${parsed.interface}" to list "${parsed.list}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "interface", before: null, after: parsed.interface }],
            },
          };
        }
        const body: Record<string, string> = { list: parsed.list, interface: parsed.interface };
        if (parsed.comment) body.comment = parsed.comment;
        const created = await context.routerClient.create("interface/list/member", body);
        log.info({ list: parsed.list, interface: parsed.interface, id: created[".id"] }, "Interface list member added");
        return {
          content: `Added "${parsed.interface}" to list "${parsed.list}".`,
          structuredContent: { action: "created", list: parsed.list, interface: parsed.interface, id: created[".id"] },
        };
      }

      if (!existing) {
        return {
          content: `Interface "${parsed.interface}" is not a member of list "${parsed.list}". Nothing to remove.`,
          structuredContent: { action: "not_found", list: parsed.list, interface: parsed.interface },
        };
      }
      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove "${parsed.interface}" from list "${parsed.list}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "interface", before: parsed.interface, after: null }],
          },
        };
      }
      await context.routerClient.remove("interface/list/member", existing[".id"]);
      log.info({ list: parsed.list, interface: parsed.interface }, "Interface list member removed");
      return {
        content: `Removed "${parsed.interface}" from list "${parsed.list}".`,
        structuredContent: {
          action: "removed",
          list: parsed.list,
          interface: parsed.interface,
          id: existing[".id"],
        },
      };
    } catch (err) {
      throw toolError(err, context, "manage_interface_list_member");
    }
  },
};

export const interfaceListTools: ToolDefinition[] = [
  listInterfaceListsTool,
  manageInterfaceListTool,
  manageInterfaceListMemberTool,
];

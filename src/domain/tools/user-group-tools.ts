import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("user-group-tools");

const listUserGroupsInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of groups to return"),
  })
  .strict();

const listUserGroupsTool: ToolDefinition = {
  name: "list_user_groups",
  title: "List User Groups",
  description: "List local user groups on a MikroTik router.",
  inputSchema: listUserGroupsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listUserGroupsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing user groups");
    try {
      const all = await context.routerClient.get<RouterOSRecord>("user/group", {
        limit: undefined,
        offset: undefined,
      });
      const groups = all.slice(0, parsed.limit);
      return {
        content: `User groups on ${context.routerId}: ${groups.length} returned (${all.length} total)`,
        structuredContent: {
          routerId: context.routerId,
          groups,
          total: all.length,
          returned: groups.length,
        },
      };
    } catch (err) {
      throw enrichError(err, { routerId: context.routerId, tool: "list_user_groups" });
    }
  },
};

const manageUserGroupInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    name: z.string().describe("Group name — idempotency key"),
    policy: z.string().optional().describe("Comma-separated policy list (e.g. 'read,write,ftp')"),
    skin: z.string().optional().describe("Optional skin name for the group"),
    dryRun: z.boolean().default(false).describe("Preview changes without applying"),
  })
  .strict();

const manageUserGroupTool: ToolDefinition = {
  name: "manage_user_group",
  title: "Manage User Group",
  description:
    "Add, update, or remove a local RouterOS user group. Idempotent by name: add returns already_exists if a group with the same name and policy already exists.",
  inputSchema: manageUserGroupInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["user/group"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageUserGroupInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing user group",
    );
    try {
      if (parsed.action === "add") {
        const all = await context.routerClient.get<RouterOSRecord>("user/group", {
          limit: undefined,
          offset: undefined,
        });
        const existing = (all as Record<string, string>[]).find((g) => g.name === parsed.name);

        if (existing) {
          if (parsed.policy === undefined || existing.policy === parsed.policy) {
            return {
              content: `User group "${parsed.name}" already exists. No changes made.`,
              structuredContent: { action: "already_exists", name: parsed.name, policy: existing.policy },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "USER_GROUP_CONFLICT",
            message: `Group "${parsed.name}" exists with a different policy.`,
            details: { existingPolicy: existing.policy, requestedPolicy: parsed.policy },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing group first or use a different name.",
              alternativeTools: ["manage_user_group"],
            },
          });
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add group "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "name", before: null, after: parsed.name },
                { property: "policy", before: null, after: parsed.policy ?? "" },
              ],
            },
          };
        }

        const body: Record<string, string> = { name: parsed.name };
        if (parsed.policy !== undefined) body.policy = parsed.policy;
        if (parsed.skin !== undefined) body.skin = parsed.skin;

        const created = await context.routerClient.create("user/group", body);
        log.info({ name: parsed.name, id: created[".id"] }, "User group added");
        return {
          content: `Added group "${parsed.name}".`,
          structuredContent: {
            action: "created",
            routerId: context.routerId,
            name: parsed.name,
            id: created[".id"],
          },
        };
      }

      if (parsed.action === "update") {
        const all = await context.routerClient.get<RouterOSRecord>("user/group", {
          limit: undefined,
          offset: undefined,
        });
        const existing = (all as Record<string, string>[]).find((g) => g.name === parsed.name);

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "USER_GROUP_NOT_FOUND",
            message: `Group "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the group name with list_user_groups.",
              alternativeTools: ["list_user_groups"],
            },
          });
        }

        if (parsed.policy !== undefined && existing.policy === parsed.policy) {
          return {
            content: `Group "${parsed.name}" already has the requested policy. No changes made.`,
            structuredContent: { action: "no_change", name: parsed.name },
          };
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update group "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                {
                  property: "policy",
                  before: existing.policy ?? null,
                  after: parsed.policy ?? null,
                },
              ],
            },
          };
        }

        const changes: Record<string, string> = {};
        if (parsed.policy !== undefined) changes.policy = parsed.policy;
        if (parsed.skin !== undefined) changes.skin = parsed.skin;

        if (Object.keys(changes).length === 0) {
          return {
            content: `User group "${parsed.name}" already has the requested configuration. No changes made.`,
            structuredContent: { action: "no_change", name: parsed.name },
          };
        }

        await context.routerClient.update("user/group", existing[".id"], changes);
        log.info({ name: parsed.name }, "User group updated");
        return {
          content: `Updated group "${parsed.name}".`,
          structuredContent: { action: "updated", routerId: context.routerId, name: parsed.name },
        };
      }

      const all = await context.routerClient.get<RouterOSRecord>("user/group", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (all as Record<string, string>[]).find((g) => g.name === parsed.name);

      if (!existing) {
        return {
          content: `Group "${parsed.name}" not found. Nothing to remove.`,
          structuredContent: { action: "not_found", name: parsed.name },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would remove group "${parsed.name}".`,
          structuredContent: {
            action: "dry_run",
            diff: [{ property: "name", before: parsed.name, after: null }],
          },
        };
      }

      await context.routerClient.remove("user/group", existing[".id"]);
      log.info({ name: parsed.name }, "User group removed");
      return {
        content: `Removed group "${parsed.name}".`,
        structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "manage_user_group" });
    }
  },
};

export const userGroupTools: ToolDefinition[] = [listUserGroupsTool, manageUserGroupTool];

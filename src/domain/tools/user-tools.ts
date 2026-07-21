import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, limit, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("user-tools");

const listUsersInputSchema = z
  .object({
    routerId,
    group: z.string().optional().describe("Filter by group name (exact match)"),
    limit,
  })
  .strict();

const listUsersTool: ToolDefinition = {
  name: "list_users",
  title: "List Users",
  description: "List local users on a MikroTik router. Passwords are never returned.",
  inputSchema: listUsersInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listUsersInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing users");
    try {
      const allUsers = await context.routerClient.get<RouterOSRecord>("user", {
        limit: undefined,
        offset: undefined,
      });

      const safeUsers = (allUsers as Record<string, string>[]).map((u) => ({
        ".id": u[".id"],
        name: u.name,
        group: u.group,
        address: u.address,
        "last-logged-in": u["last-logged-in"],
        disabled: u.disabled,
        comment: u.comment,
      }));

      const filtered = parsed.group
        ? safeUsers.filter((u) => u.group === parsed.group)
        : safeUsers;
      const users = filtered.slice(0, parsed.limit);

      return {
        content: listContent(
          "Users",
          context.routerId,
          users,
          allUsers.length,
          0,
          (u) => compactFields(u, ["name", "group", "address", "disabled", "comment"]),
        ),
        structuredContent: {
          routerId: context.routerId,
          users,
          total: allUsers.length,
          returned: users.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "list_users");
    }
  },
};

const manageUserInputSchema = z
  .object({
    routerId,
    action: z
      .enum(["add", "remove", "enable", "disable", "set-password"])
      .describe("Action to perform"),
    name: z.string().describe("Username — idempotency key"),
    group: z
      .string()
      .optional()
      .describe("Group name (required for add; e.g. 'read', 'write', 'full')"),
    password: z.string().optional().describe("Password (required for add and set-password)"),
    address: z.string().optional().describe("Allowed source address or range"),
    comment: z.string().optional().describe("Optional comment"),
    dryRun,
  })
  .strict();

const manageUserTool: ToolDefinition = {
  name: "manage_user",
  title: "Manage User",
  description:
    "Add, remove, enable, disable, or set the password for a local RouterOS user. Idempotent by name: add returns already_exists if a user with the same name and group already exists.",
  inputSchema: manageUserInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["user"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageUserInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing user",
    );
    try {
      if (parsed.action === "add") {
        if (!parsed.group) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "USER_GROUP_REQUIRED",
            message: "group is required when adding a user.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a group name (e.g. 'read', 'write', 'full').",
            },
          });
        }
        if (!parsed.password) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "USER_PASSWORD_REQUIRED",
            message: "password is required when adding a user.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide a password for the new user.",
            },
          });
        }

        const allUsers = await context.routerClient.get<RouterOSRecord>("user", {
          limit: undefined,
          offset: undefined,
        });
        const existing = (allUsers as Record<string, string>[]).find(
          (u) => u.name === parsed.name,
        );

        if (existing) {
          if (existing.group === parsed.group) {
            return {
              content: `User "${parsed.name}" already exists in group "${parsed.group}". No changes made.`,
              structuredContent: { action: "already_exists", name: parsed.name, group: existing.group },
            };
          }
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "USER_CONFLICT",
            message: `User "${parsed.name}" exists in a different group.`,
            details: { existingGroup: existing.group, requestedGroup: parsed.group },
            recoverability: {
              retryable: false,
              suggestedAction: "Remove the existing user first or use a different username.",
              alternativeTools: ["manage_user"],
            },
          });
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would add user "${parsed.name}" in group "${parsed.group}".`,
            structuredContent: {
              action: "dry_run",
              diff: [
                { property: "name", before: null, after: parsed.name },
                { property: "group", before: null, after: parsed.group },
                ...(parsed.address
                  ? [{ property: "address", before: null, after: parsed.address }]
                  : []),
                ...(parsed.comment
                  ? [{ property: "comment", before: null, after: parsed.comment }]
                  : []),
              ],
            },
          };
        }

        const body: Record<string, string> = {
          name: parsed.name,
          group: parsed.group,
          password: parsed.password,
        };
        if (parsed.address) body.address = parsed.address;
        if (parsed.comment) body.comment = parsed.comment;

        const created = await context.routerClient.create("user", body);
        log.info({ name: parsed.name, id: created[".id"] }, "User added");
        return {
          content: `Added user "${parsed.name}" in group "${parsed.group}".`,
          structuredContent: { action: "created", routerId: context.routerId, name: parsed.name, group: parsed.group },
        };
      }

      if (parsed.action === "set-password") {
        if (!parsed.password) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "USER_PASSWORD_REQUIRED",
            message: "password is required for set-password action.",
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the new password.",
            },
          });
        }

        const allUsers = await context.routerClient.get<RouterOSRecord>("user", {
          limit: undefined,
          offset: undefined,
        });
        const existing = (allUsers as Record<string, string>[]).find(
          (u) => u.name === parsed.name,
        );

        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "USER_NOT_FOUND",
            message: `User "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the username with list_users.",
              alternativeTools: ["list_users"],
            },
          });
        }

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would update password for user "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "password", before: "***", after: "***" }],
            },
          };
        }

        await context.routerClient.update("user", existing[".id"], {
          password: parsed.password,
        });
        log.info({ name: parsed.name }, "User password updated");
        return {
          content: `Password updated for user "${parsed.name}".`,
          structuredContent: { action: "password_set", routerId: context.routerId, name: parsed.name },
        };
      }

      // remove / enable / disable share a common lookup
      const allUsers = await context.routerClient.get<RouterOSRecord>("user", {
        limit: undefined,
        offset: undefined,
      });
      const existing = (allUsers as Record<string, string>[]).find(
        (u) => u.name === parsed.name,
      );

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `User "${parsed.name}" not found. Nothing to remove.`,
            structuredContent: { action: "not_found", name: parsed.name },
          };
        }
        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove user "${parsed.name}".`,
            structuredContent: {
              action: "dry_run",
              diff: [{ property: "name", before: parsed.name, after: null }],
            },
          };
        }
        await context.routerClient.remove("user", existing[".id"]);
        log.info({ name: parsed.name }, "User removed");
        return {
          content: `Removed user "${parsed.name}".`,
          structuredContent: { action: "removed", name: parsed.name, id: existing[".id"] },
        };
      }

      // enable / disable
      if (!existing) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "USER_NOT_FOUND",
          message: `User "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the username with list_users.",
            alternativeTools: ["list_users"],
          },
        });
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would ${parsed.action} user "${parsed.name}".`,
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
      await context.routerClient.update("user", existing[".id"], {
        disabled: disabledValue,
      });
      const resultAction = parsed.action === "disable" ? "disabled" : "enabled";
      log.info({ name: parsed.name, action: resultAction }, "User updated");
      return {
        content: `User "${parsed.name}" ${resultAction}.`,
        structuredContent: { action: resultAction, name: parsed.name, id: existing[".id"] },
      };
    } catch (err) {
      throw toolError(err, context, "manage_user");
    }
  },
};

export const userTools: ToolDefinition[] = [listUsersTool, manageUserTool];

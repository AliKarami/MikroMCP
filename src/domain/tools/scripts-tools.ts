import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { dryRun, routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("scripts-tools");

const SCRIPT_PATH = "system/script";

const listScriptsInputSchema = z
  .object({
    routerId,
    name: z.string().optional().describe("Filter by script name (substring match)"),
  })
  .strict();

const listScriptsTool: ToolDefinition = {
  name: "list_scripts",
  title: "List Scripts",
  description: "List RouterOS scripts on a MikroTik router. Supports optional name filter.",
  inputSchema: listScriptsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listScriptsInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing scripts");

    try {
      let scripts = await context.routerClient.get<RouterOSRecord>(SCRIPT_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.name !== undefined) {
        const needle = parsed.name.toLowerCase();
        scripts = scripts.filter((s) =>
          ((s as Record<string, string>).name ?? "").toLowerCase().includes(needle),
        );
      }

      return {
        content: listContent(
          "Scripts",
          context.routerId,
          scripts as Record<string, string>[],
          scripts.length,
          0,
          (s) => compactFields(s, ["name", "owner", "policy", "run-count", "last-started"]),
        ),
        structuredContent: { routerId: context.routerId, scripts, total: scripts.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_scripts");
    }
  },
};

const manageScriptInputSchema = z
  .object({
    routerId,
    action: z.enum(["add", "update", "remove"]).describe("Action to perform"),
    name: z.string().describe("Script name — idempotency key"),
    source: z.string().optional().describe("Script body (required for add and update)"),
    comment: z.string().optional().describe("Optional comment"),
    dontRequirePermissions: z
      .boolean()
      .optional()
      .describe("Allow script to run without elevated permissions"),
    dryRun,
  })
  .strict();

const manageScriptTool: ToolDefinition = {
  name: "manage_script",
  title: "Manage Script",
  description:
    "Add, update, or remove a RouterOS script. Idempotent by name. add throws CONFLICT if the name already exists; update throws NOT_FOUND if it does not. Supports dry-run.",
  inputSchema: manageScriptInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["system/script"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = manageScriptInputSchema.parse(params);
    log.info(
      { routerId: context.routerId, action: parsed.action, name: parsed.name },
      "Managing script",
    );

    try {
      const all = await context.routerClient.get<RouterOSRecord>(SCRIPT_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const existing = all.find((s) => (s as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (parsed.action === "add") {
        if (parsed.source === undefined) {
          throw new MikroMCPError({
            category: ErrorCategory.VALIDATION,
            code: "SOURCE_REQUIRED",
            message: "source is required when action is add",
            recoverability: {
              retryable: false,
              suggestedAction: "Provide the script body in the source field.",
            },
          });
        }

        if (existing) {
          throw new MikroMCPError({
            category: ErrorCategory.CONFLICT,
            code: "SCRIPT_CONFLICT",
            message: `Script "${parsed.name}" already exists. Use action=update to modify it.`,
            details: { existing: { name: existing.name, ".id": existing[".id"] } },
            recoverability: {
              retryable: false,
              suggestedAction:
                "Use action=update to change the source, or action=remove then re-add.",
              alternativeTools: ["manage_script with action=update"],
            },
          });
        }

        const body: Record<string, string> = { name: parsed.name, source: parsed.source };
        if (parsed.comment !== undefined) body.comment = parsed.comment;
        if (parsed.dontRequirePermissions !== undefined)
          body["dont-require-permissions"] = parsed.dontRequirePermissions ? "yes" : "no";

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: null,
            after,
          }));
          return {
            content: `Dry run: Would add script "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        const created = await context.routerClient.create(SCRIPT_PATH, body);
        log.info({ name: parsed.name, id: created[".id"] }, "Script added");
        return {
          content: `Added script "${parsed.name}".`,
          structuredContent: { action: "created", script: created },
        };
      }

      if (parsed.action === "update") {
        if (!existing) {
          throw new MikroMCPError({
            category: ErrorCategory.NOT_FOUND,
            code: "SCRIPT_NOT_FOUND",
            message: `Script "${parsed.name}" not found.`,
            details: { name: parsed.name },
            recoverability: {
              retryable: false,
              suggestedAction: "Verify the name with list_scripts, or use action=add to create it.",
              alternativeTools: ["list_scripts", "manage_script with action=add"],
            },
          });
        }

        const id = existing[".id"];
        const body: Record<string, string> = {};
        if (parsed.source !== undefined) body.source = parsed.source;
        if (parsed.comment !== undefined) body.comment = parsed.comment;
        if (parsed.dontRequirePermissions !== undefined)
          body["dont-require-permissions"] = parsed.dontRequirePermissions ? "yes" : "no";

        if (parsed.dryRun) {
          const diff = Object.entries(body).map(([property, after]) => ({
            property,
            before: existing[property] ?? null,
            after,
          }));
          return {
            content: `Dry run: Would update script "${parsed.name}".`,
            structuredContent: { action: "dry_run", diff },
          };
        }

        await context.routerClient.update(SCRIPT_PATH, id, body);
        log.info({ name: parsed.name, id }, "Script updated");
        return {
          content: `Updated script "${parsed.name}".`,
          structuredContent: { action: "updated", name: parsed.name, id },
        };
      }

      if (parsed.action === "remove") {
        if (!existing) {
          return {
            content: `Script "${parsed.name}" does not exist. No changes made.`,
            structuredContent: { action: "already_removed", name: parsed.name },
          };
        }

        const id = existing[".id"];

        if (parsed.dryRun) {
          return {
            content: `Dry run: Would remove script "${parsed.name}".`,
            structuredContent: { action: "dry_run", id, name: parsed.name },
          };
        }

        await context.routerClient.remove(SCRIPT_PATH, id);
        log.info({ name: parsed.name, id }, "Script removed");
        return {
          content: `Removed script "${parsed.name}".`,
          structuredContent: { action: "removed", id, name: parsed.name },
        };
      }

      throw new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "INVALID_ACTION",
        message: `Unknown action: ${parsed.action as string}`,
        recoverability: { retryable: false, suggestedAction: "Use one of: add, update, remove." },
      });
    } catch (err) {
      throw toolError(err, context, "manage_script");
    }
  },
};

const runScriptInputSchema = z
  .object({
    routerId,
    name: z.string().describe("Name of the script to execute"),
  })
  .strict();

const runScriptTool: ToolDefinition = {
  name: "run_script",
  title: "Run Script",
  description:
    "Execute a named RouterOS script. Fire-and-forget — the script runs asynchronously and its output is written to the router system log. Use get_log after calling this tool to see results.",
  inputSchema: runScriptInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = runScriptInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Running script");

    try {
      const all = await context.routerClient.get<RouterOSRecord>(SCRIPT_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const script = all.find((s) => (s as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (!script) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "SCRIPT_NOT_FOUND",
          message: `Script "${parsed.name}" not found.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the script name with list_scripts.",
            alternativeTools: ["list_scripts"],
          },
        });
      }

      await context.routerClient.execute(`${SCRIPT_PATH}/run`, { number: parsed.name });
      log.info({ name: parsed.name }, "Script executed");

      return {
        content: `Script "${parsed.name}" executed. Check get_log for output.`,
        structuredContent: { action: "executed", name: parsed.name },
      };
    } catch (err) {
      throw toolError(err, context, "run_script");
    }
  },
};

export const scriptsTools: ToolDefinition[] = [listScriptsTool, manageScriptTool, runScriptTool];

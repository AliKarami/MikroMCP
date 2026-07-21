import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("backup-tools");

const createBackupInputSchema = z
  .object({
    routerId,
    name: z.string().default("backup").describe("Backup file name (without extension)"),
    password: z.string().optional().describe("Password to encrypt the backup file"),
    dryRun: z.boolean().default(false).describe("Preview the backup without creating it"),
  })
  .strict();

const createBackupTool: ToolDefinition = {
  name: "create_backup",
  title: "Create Backup",
  description:
    "Create a binary configuration backup on a MikroTik router. The backup is saved as <name>.backup on the router's filesystem. Supports optional encryption via password and dry-run mode.",
  inputSchema: createBackupInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = createBackupInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Creating backup");

    if (parsed.dryRun) {
      return {
        content: `Dry run: Would create backup "${parsed.name}.backup" on ${context.routerId}.`,
        structuredContent: { action: "dry_run", name: parsed.name, routerId: context.routerId },
      };
    }

    try {
      const body: Record<string, string> = { name: parsed.name };
      if (parsed.password !== undefined) {
        body.password = parsed.password;
      }

      await context.routerClient.execute("system/backup/save", body);
      log.info({ routerId: context.routerId, name: parsed.name }, "Backup created");

      return {
        content: `Backup "${parsed.name}.backup" created on ${context.routerId}.`,
        structuredContent: {
          action: "created",
          routerId: context.routerId,
          filePath: `${parsed.name}.backup`,
        },
      };
    } catch (err) {
      throw toolError(err, context, "create_backup");
    }
  },
};

const exportConfigInputSchema = z
  .object({
    routerId,
    compact: z
      .boolean()
      .default(false)
      .describe("Export only non-default settings (compact format)"),
    file: z
      .string()
      .optional()
      .describe("Save the export to a file on the router (without extension); omit to return inline"),
  })
  .strict();

const exportConfigTool: ToolDefinition = {
  name: "export_config",
  title: "Export Config",
  description:
    "Export the router configuration as a RouterOS script. When no file is specified, returns the script text inline. When a file is specified, saves it as <file>.rsc on the router's filesystem. Supports compact mode to show only non-default values.",
  inputSchema: exportConfigInputSchema,
  // Not read-only: with a `file` argument it writes a file on the router.
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = exportConfigInputSchema.parse(params);
    log.info({ routerId: context.routerId, compact: parsed.compact }, "Exporting config");

    try {
      if (parsed.file !== undefined) {
        const body: Record<string, string> = { file: parsed.file };
        if (parsed.compact) body.compact = "yes";
        await context.routerClient.execute("system/export", body);
        return {
          content: `Config exported to "${parsed.file}.rsc" on ${context.routerId}.`,
          structuredContent: {
            routerId: context.routerId,
            filePath: `${parsed.file}.rsc`,
          },
        };
      }

      // RouterOS REST API returns [] for inline export — text output requires SSH.
      const sshCommand = parsed.compact ? "export compact" : "export";
      const scriptText = await context.sshClient.execute(sshCommand);

      return {
        content: `Config export from ${context.routerId}:\n${scriptText}`,
        structuredContent: {
          routerId: context.routerId,
          script: scriptText,
          compact: parsed.compact,
        },
      };
    } catch (err) {
      throw toolError(err, context, "export_config");
    }
  },
};

export const backupTools: ToolDefinition[] = [createBackupTool, exportConfigTool];

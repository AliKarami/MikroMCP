import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import { createLogger } from "../../observability/logger.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

const log = createLogger("backup-tools");

const createBackupInputSchema = z
  .object({
    routerId,
    name: z.string().default("backup").describe("Backup file name (without extension)"),
    password: z
      .string()
      .optional()
      .describe(
        "Literal password to encrypt the backup. It stays in the conversation history; prefer passwordSecret",
      ),
    passwordSecret: z
      .string()
      .regex(/^[A-Z0-9_]+$/, "a secret name is the NAME of MIKROMCP_SECRET_<NAME>")
      .optional()
      .describe(
        "Encrypt with the server's MIKROMCP_SECRET_<NAME> value, bound to this router by its secrets list in routers.yaml. The value never reaches the conversation",
      ),
    dryRun: z.boolean().default(false).describe("Preview the backup without creating it"),
  })
  .strict();

type CreateBackupInput = z.infer<typeof createBackupInputSchema>;

function backupError(code: string, message: string, suggestedAction: string): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code,
    message,
    recoverability: { retryable: false, suggestedAction },
  });
}

/**
 * The backup password: the literal one, or the router-bound secret named by
 * passwordSecret. Checked before a dry run returns too, so a preview proves the
 * secret resolves. The value never goes into a result, error or log.
 */
function resolveBackupPassword(
  parsed: CreateBackupInput,
  context: ToolContext,
): string | undefined {
  const name = parsed.passwordSecret;
  if (name === undefined) return parsed.password;

  if (parsed.password !== undefined) {
    throw backupError(
      "BACKUP_PASSWORD_CONFLICT",
      "Pass either password or passwordSecret, not both.",
      "Drop password and keep passwordSecret, so the password stays out of the conversation.",
    );
  }
  const bound = context.routerConfig.secrets ?? [];
  if (!bound.includes(name)) {
    throw backupError(
      "BACKUP_SECRET_NOT_BOUND",
      bound.length
        ? `Secret ${name} is not bound to router "${context.routerId}" (its routers.yaml secrets list names ${bound.join(", ")}).`
        : `Router "${context.routerId}" has no secrets list in routers.yaml, so it may use no secret.`,
      `Add ${name} to the router's \`secrets\` list in routers.yaml if it is meant for it.`,
    );
  }
  const value = context.appConfig.configSecrets[name];
  if (!value) {
    throw backupError(
      "BACKUP_SECRET_MISSING",
      `Secret ${name} is bound to router "${context.routerId}", but MIKROMCP_SECRET_${name} is not set or empty.`,
      `Set MIKROMCP_SECRET_${name} in the MikroMCP server's environment and restart it.`,
    );
  }
  return value;
}

const createBackupTool: ToolDefinition = {
  name: "create_backup",
  title: "Create Backup",
  description:
    "Create a binary configuration backup on a MikroTik router. The backup is saved as <name>.backup on the router's filesystem. To encrypt it, prefer passwordSecret (a MIKROMCP_SECRET_<NAME> bound to the router in routers.yaml — the password never reaches the conversation) over a literal password. Dry run checks that the secret resolves.",
  inputSchema: createBackupInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = createBackupInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Creating backup");

    const password = resolveBackupPassword(parsed, context);
    const encrypted = password !== undefined && password !== "";
    const how = encrypted ? "encrypted " : "";

    if (parsed.dryRun) {
      return {
        content: `Dry run: Would create ${how}backup "${parsed.name}.backup" on ${context.routerId}.`,
        structuredContent: {
          action: "dry_run",
          name: parsed.name,
          routerId: context.routerId,
          encrypted,
        },
      };
    }

    try {
      const body: Record<string, string> = { name: parsed.name };
      if (password !== undefined) {
        body.password = password;
      }

      await context.routerClient.execute("system/backup/save", body);
      log.info({ routerId: context.routerId, name: parsed.name, encrypted }, "Backup created");

      return {
        content: `Backup "${parsed.name}.backup" created ${how}on ${context.routerId}.`,
        structuredContent: {
          action: "created",
          routerId: context.routerId,
          filePath: `${parsed.name}.backup`,
          encrypted,
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
      .describe(
        "Save the export to a file on the router (without extension); omit to return inline",
      ),
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
    destructiveHint: true,
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

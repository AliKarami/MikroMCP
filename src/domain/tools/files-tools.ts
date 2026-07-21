import { z } from "zod";
import { listContent, compactFields } from "./pagination.js";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import { routerId } from "./schema-fields.js";
import { toolError } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("files-tools");

const FILE_PATH = "file";
const CONTENT_CAP = 65536;

const listFilesInputSchema = z
  .object({
    routerId,
    name: z.string().optional().describe("Filter by file name (substring match)"),
    type: z.string().optional().describe("Filter by file type (e.g. script, backup, package)"),
  })
  .strict();

const listFilesTool: ToolDefinition = {
  name: "list_files",
  title: "List Files",
  description: "List files on a MikroTik router filesystem. Supports filtering by name and type.",
  inputSchema: listFilesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = listFilesInputSchema.parse(params);
    log.info({ routerId: context.routerId }, "Listing files");

    try {
      let files = await context.routerClient.get<RouterOSRecord>(FILE_PATH, {
        limit: undefined,
        offset: undefined,
      });

      if (parsed.name !== undefined) {
        const needle = parsed.name.toLowerCase();
        files = files.filter((f) =>
          ((f as Record<string, string>).name ?? "").toLowerCase().includes(needle),
        );
      }

      if (parsed.type !== undefined) {
        files = files.filter((f) => (f as Record<string, string>).type === parsed.type);
      }

      return {
        content: listContent(
          "Files",
          context.routerId,
          files as Record<string, string>[],
          files.length,
          0,
          (f) => compactFields(f, ["name", "type", "size", "creation-time"]),
        ),
        structuredContent: { routerId: context.routerId, files, total: files.length },
      };
    } catch (err) {
      throw toolError(err, context, "list_files");
    }
  },
};

const getFileContentInputSchema = z
  .object({
    routerId,
    name: z.string().describe("Exact file name on the router (e.g. flash/script.rsc)"),
  })
  .strict();

const getFileContentTool: ToolDefinition = {
  name: "get_file_content",
  title: "Get File Content",
  description:
    "Read a text file's contents from a MikroTik router. Only suitable for text files — binary files will return garbled content.",
  inputSchema: getFileContentInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = getFileContentInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Getting file content");

    try {
      const all = await context.routerClient.get<RouterOSRecord>(FILE_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const file = all.find((f) => (f as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (!file) {
        throw new MikroMCPError({
          category: ErrorCategory.NOT_FOUND,
          code: "FILE_NOT_FOUND",
          message: `File "${parsed.name}" not found on router.`,
          details: { name: parsed.name },
          recoverability: {
            retryable: false,
            suggestedAction: "Verify the file name with list_files.",
            alternativeTools: ["list_files"],
          },
        });
      }

      const id = file[".id"];
      const full = await context.routerClient.getOne<Record<string, string>>(FILE_PATH, id);
      const rawContents = full.contents ?? "";
      const truncated = rawContents.length > CONTENT_CAP;
      const contents = truncated
        ? `${rawContents.slice(0, CONTENT_CAP)}\n[TRUNCATED at ${CONTENT_CAP} chars — file is ${rawContents.length} chars]`
        : rawContents;

      return {
        content: `Contents of "${parsed.name}" on ${context.routerId}:\n${contents}`,
        structuredContent: {
          routerId: context.routerId,
          name: parsed.name,
          contents,
          truncated,
          totalLength: rawContents.length,
        },
      };
    } catch (err) {
      throw toolError(err, context, "get_file_content");
    }
  },
};

const uploadFileInputSchema = z
  .object({
    routerId,
    name: z.string().describe("Target filename on the router (e.g. flash/my-script.rsc)"),
    content: z.string().describe("File content to upload (text)"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Validate FTP connectivity without writing the file"),
  })
  .strict();

const uploadFileTool: ToolDefinition = {
  name: "upload_file",
  title: "Upload File",
  description:
    "Upload a text file to a router via FTP using the router's credentials, overwriting any existing file of the same name. Requires FTP permission on the router user (see config/routers.example.yaml). Dry-run tests FTP connectivity only.",
  inputSchema: uploadFileInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  snapshotPaths: ["file"],
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = uploadFileInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Uploading file");

    try {
      if (parsed.dryRun) {
        await context.ftpClient.connect();
        return {
          content: `Dry run: FTP connectivity to ${context.routerId} verified. Would upload "${parsed.name}".`,
          structuredContent: { action: "dry_run", name: parsed.name, routerId: context.routerId },
        };
      }

      await context.ftpClient.upload(parsed.name, parsed.content);
      log.info({ name: parsed.name }, "File uploaded via FTP");

      return {
        content: `Uploaded "${parsed.name}" to ${context.routerId}.`,
        structuredContent: { action: "uploaded", name: parsed.name, routerId: context.routerId },
      };
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        throw new MikroMCPError({
          category: ErrorCategory.CONFIGURATION,
          code: "FTP_SERVICE_UNAVAILABLE",
          message: `FTP service is not running on ${context.routerConfig.host}:21. Enable it on the router and ensure the user has the 'ftp' policy.`,
          details: { host: context.routerConfig.host, port: 21, routerId: context.routerId },
          recoverability: {
            retryable: false,
            suggestedAction:
              "Run on the router: /ip service enable ftp  — then add 'ftp' to the user group policy: /user group set <group> policy=...,ftp,...",
          },
        });
      }
      throw toolError(err, context, "upload_file");
    }
  },
};

const deleteFileInputSchema = z
  .object({
    routerId,
    name: z.string().describe("Exact file name on the router (e.g. flash/backup.backup)"),
    dryRun: z.boolean().default(false).describe("Preview deletion without removing the file"),
  })
  .strict();

const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  title: "Delete File",
  description:
    "Delete a file from the router filesystem by name. Idempotent: returns not_found gracefully if the file does not exist.",
  inputSchema: deleteFileInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = deleteFileInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Deleting file");
    try {
      const all = await context.routerClient.get<RouterOSRecord>(FILE_PATH, {
        limit: undefined,
        offset: undefined,
      });
      const file = all.find((f) => (f as Record<string, string>).name === parsed.name) as
        | Record<string, string>
        | undefined;

      if (!file) {
        return {
          content: `File "${parsed.name}" not found on ${context.routerId}. Nothing to delete.`,
          structuredContent: { action: "not_found", name: parsed.name, routerId: context.routerId },
        };
      }

      if (parsed.dryRun) {
        return {
          content: `Dry run: Would delete "${parsed.name}" from ${context.routerId}.`,
          structuredContent: {
            action: "dry_run",
            name: parsed.name,
            id: file[".id"],
            routerId: context.routerId,
          },
        };
      }

      await context.routerClient.remove(FILE_PATH, file[".id"]);
      log.info({ name: parsed.name, id: file[".id"] }, "File deleted");
      return {
        content: `Deleted "${parsed.name}" from ${context.routerId}.`,
        structuredContent: {
          action: "deleted",
          name: parsed.name,
          id: file[".id"],
          routerId: context.routerId,
        },
      };
    } catch (err) {
      throw toolError(err, context, "delete_file");
    }
  },
};

export const filesTools: ToolDefinition[] = [
  listFilesTool,
  getFileContentTool,
  uploadFileTool,
  deleteFileTool,
];

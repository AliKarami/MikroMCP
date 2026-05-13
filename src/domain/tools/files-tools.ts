import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "./tool-definition.js";
import type { RouterOSRecord } from "../../types.js";
import { enrichError } from "../errors/error-enricher.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";
import { createLogger } from "../../observability/logger.js";
import { ftpUpload, ftpConnect } from "../../adapter/ftp-client.js";

const log = createLogger("files-tools");

const FILE_PATH = "file";

const listFilesInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
    name: z.string().optional().describe("Filter by file name (substring match)"),
    type: z
      .string()
      .optional()
      .describe("Filter by file type (e.g. script, backup, package)"),
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
        content: `Files on ${context.routerId}: ${files.length} file(s).`,
        structuredContent: { routerId: context.routerId, files, total: files.length },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "list_files" });
    }
  },
};

const getFileContentInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
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
      const file = all.find(
        (f) => (f as Record<string, string>).name === parsed.name,
      ) as Record<string, string> | undefined;

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
      const contents = full.contents ?? "";

      return {
        content: `Contents of "${parsed.name}" on ${context.routerId}:\n${contents}`,
        structuredContent: { routerId: context.routerId, name: parsed.name, contents },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "get_file_content" });
    }
  },
};

const uploadFileInputSchema = z
  .object({
    routerId: z.string().describe("Target router identifier from the router registry"),
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
    "Upload a text file to a MikroTik router via FTP using the router's credentials. Overwrites any existing file with the same name. Requires FTP permission on the router user — see config/routers.example.yaml for setup instructions. Supports dry-run (tests FTP connectivity only).",
  inputSchema: uploadFileInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = uploadFileInputSchema.parse(params);
    log.info({ routerId: context.routerId, name: parsed.name }, "Uploading file");

    const ftpOptions = {
      host: context.routerConfig.host,
      port: 21,
      user: context.credentials.username,
      password: context.credentials.password,
    };

    try {
      if (parsed.dryRun) {
        await ftpConnect(ftpOptions);
        return {
          content: `Dry run: FTP connectivity to ${context.routerId} verified. Would upload "${parsed.name}".`,
          structuredContent: { action: "dry_run", name: parsed.name, routerId: context.routerId },
        };
      }

      await ftpUpload(ftpOptions, parsed.name, parsed.content);
      log.info({ name: parsed.name }, "File uploaded via FTP");

      return {
        content: `Uploaded "${parsed.name}" to ${context.routerId}.`,
        structuredContent: { action: "uploaded", name: parsed.name, routerId: context.routerId },
      };
    } catch (err) {
      if (err instanceof MikroMCPError) throw err;
      throw enrichError(err, { routerId: context.routerId, tool: "upload_file" });
    }
  },
};

export const filesTools: ToolDefinition[] = [listFilesTool, getFileContentTool, uploadFileTool];

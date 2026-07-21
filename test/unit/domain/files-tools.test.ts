import { describe, it, expect, vi, beforeEach } from "vitest";
import { filesTools } from "../../../src/domain/tools/files-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { z } from "zod";

function makeRouterConfig(): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
  };
}

function makeContext(
  overrides: {
    get?: ReturnType<typeof vi.fn>;
    getOne?: ReturnType<typeof vi.fn>;
    ftpUpload?: ReturnType<typeof vi.fn>;
    ftpConnect?: ReturnType<typeof vi.fn>;
    sftpUpload?: ReturnType<typeof vi.fn>;
  } = {},
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: {
      upload: overrides.ftpUpload ?? vi.fn().mockResolvedValue(undefined),
      connect: overrides.ftpConnect ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    sftpClient: {
      upload: overrides.sftpUpload ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as ToolContext["sftpClient"],
    routerClient: {
      get: overrides.get ?? vi.fn().mockResolvedValue([]),
      getOne: overrides.getOne ?? vi.fn().mockResolvedValue({}),
    } as unknown as RouterOSRestClient,
  };
}

const listFilesTool = filesTools[0];
const getFileContentTool = filesTools[1];
const uploadFileTool = filesTools[2];

const listSchema = z
  .object({
    routerId: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
  })
  .strict();

const getContentSchema = z.object({ routerId: z.string(), name: z.string() }).strict();

const uploadSchema = z
  .object({
    routerId: z.string(),
    name: z.string(),
    content: z.string(),
    dryRun: z.boolean().default(false),
  })
  .strict();

describe("files tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("metadata", () => {
    it("exports 4 tools", () => {
      expect(filesTools).toHaveLength(4);
      expect(listFilesTool.name).toBe("list_files");
      expect(getFileContentTool.name).toBe("get_file_content");
      expect(uploadFileTool.name).toBe("upload_file");
    });

    it("list_files has readOnlyHint true", () => {
      expect(listFilesTool.annotations.readOnlyHint).toBe(true);
    });

    it("get_file_content has readOnlyHint true", () => {
      expect(getFileContentTool.annotations.readOnlyHint).toBe(true);
    });

    it("upload_file has readOnlyHint false and idempotentHint true", () => {
      expect(uploadFileTool.annotations.readOnlyHint).toBe(false);
      expect(uploadFileTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("list_files input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listSchema.parse({ routerId: "r" })).not.toThrow();
    });
    it("rejects extra fields", () => {
      expect(() => listSchema.parse({ routerId: "r", extra: true })).toThrow();
    });
  });

  describe("upload_file input schema", () => {
    it("accepts valid input with default dryRun", () => {
      const r = uploadSchema.parse({ routerId: "r", name: "test.rsc", content: ":log info" });
      expect(r.dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(() =>
        uploadSchema.parse({ routerId: "r", name: "f", content: "c", extra: true }),
      ).toThrow();
    });
  });

  describe("list_files handler", () => {
    it("returns all files with total", async () => {
      const files = [
        { ".id": "*1", name: "backup.backup", type: "backup", size: "1024" },
        { ".id": "*2", name: "flash/routeros-7.14.npk", type: "package", size: "20480" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(files) });
      const result = await listFilesTool.handler({ routerId: "test-router" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by name substring", async () => {
      const files = [
        { ".id": "*1", name: "backup.backup", type: "backup", size: "1024" },
        { ".id": "*2", name: "script.rsc", type: "script", size: "512" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(files) });
      const result = await listFilesTool.handler({ routerId: "test-router", name: "back" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.files as unknown[]).length).toBe(1);
    });

    it("filters by type", async () => {
      const files = [
        { ".id": "*1", name: "backup.backup", type: "backup", size: "1024" },
        { ".id": "*2", name: "script.rsc", type: "script", size: "512" },
      ];
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(files) });
      const result = await listFilesTool.handler({ routerId: "test-router", type: "script" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.files as unknown[]).length).toBe(1);
    });
  });

  describe("get_file_content handler", () => {
    it("returns file contents when found", async () => {
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "script.rsc", type: "script" }]),
        getOne: vi
          .fn()
          .mockResolvedValue({ ".id": "*1", name: "script.rsc", contents: ":log info msg" }),
      });
      const result = await getFileContentTool.handler(
        { routerId: "test-router", name: "script.rsc" },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).contents).toBe(":log info msg");
    });

    it("throws NOT_FOUND when file does not exist", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue([]) });
      await expect(
        getFileContentTool.handler({ routerId: "test-router", name: "missing.rsc" }, ctx),
      ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    });

    it("caps oversized file content and flags truncation", async () => {
      const big = "x".repeat(70000);
      const ctx = makeContext({
        get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "big.txt", type: "file" }]),
        getOne: vi.fn().mockResolvedValue({ ".id": "*1", name: "big.txt", contents: big }),
      });
      const result = await getFileContentTool.handler(
        { routerId: "test-router", name: "big.txt" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.truncated).toBe(true);
      expect(sc.totalLength).toBe(70000);
      expect((sc.contents as string).length).toBeLessThan(70000);
      expect(result.content).toContain("[TRUNCATED at 65536 chars");
    });
  });

  describe("upload_file handler", () => {
    it("uploads via SFTP by default", async () => {
      const sftpUpload = vi.fn().mockResolvedValue(undefined);
      const ftpUpload = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ sftpUpload, ftpUpload });
      const result = await uploadFileTool.handler(
        { routerId: "test-router", name: "test.rsc", content: ":log info" },
        ctx,
      );
      expect(sftpUpload).toHaveBeenCalledWith("test.rsc", ":log info");
      expect(ftpUpload).not.toHaveBeenCalled();
      expect((result.structuredContent as Record<string, unknown>).transport).toBe("sftp");
    });

    it("falls back to FTP (plaintext) when SFTP fails", async () => {
      const sftpUpload = vi.fn().mockRejectedValue(new Error("no ssh"));
      const ftpUpload = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ sftpUpload, ftpUpload });
      const result = await uploadFileTool.handler(
        { routerId: "test-router", name: "test.rsc", content: ":log info" },
        ctx,
      );
      expect(ftpUpload).toHaveBeenCalledWith("test.rsc", ":log info");
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.transport).toBe("ftp");
      expect(result.content).toMatch(/plaintext/i);
    });

    it("probes SFTP on dry-run without uploading real content", async () => {
      const sftpUpload = vi.fn().mockResolvedValue(undefined);
      const ftpUpload = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ sftpUpload, ftpUpload });
      const result = await uploadFileTool.handler(
        { routerId: "test-router", name: "test.rsc", content: ":log info", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect((result.structuredContent as Record<string, unknown>).transport).toBe("sftp");
      expect(ftpUpload).not.toHaveBeenCalled();
    });

    it("throws FILE_TRANSFER_UNAVAILABLE when neither SFTP nor FTP is reachable", async () => {
      const connRefused = Object.assign(new Error("connect ECONNREFUSED 192.168.1.1:21"), {
        code: "ECONNREFUSED",
      });
      const sftpUpload = vi.fn().mockRejectedValue(new Error("no ssh"));
      const ftpUpload = vi.fn().mockRejectedValue(connRefused);
      const ctx = makeContext({ sftpUpload, ftpUpload });
      await expect(
        uploadFileTool.handler({ routerId: "test-router", name: "test.rsc", content: "x" }, ctx),
      ).rejects.toMatchObject({ code: "FILE_TRANSFER_UNAVAILABLE" });
    });
  });
});

describe("delete_file", () => {
  const deleteFileTool = filesTools.find((t) => t.name === "delete_file")!;

  const FILE_RECORD = { ".id": "*A", name: "flash/my-backup.backup", type: "backup", size: "1024" };

  function makeDeleteContext(files: Record<string, unknown>[] = [FILE_RECORD]) {
    return {
      routerId: "test-router",
      correlationId: "test-corr",
      routerConfig: {} as RouterConfig,
      sshClient: {} as SshClient,
      ftpClient: {} as FtpClient,
      identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
      routerClient: {
        get: vi.fn().mockResolvedValue(files),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as RouterOSRestClient,
    } as unknown as ToolContext;
  }

  describe("metadata", () => {
    it("exists in filesTools", () => expect(deleteFileTool).toBeDefined());
    it("is not readOnly", () => expect(deleteFileTool.annotations.readOnlyHint).toBe(false));
    it("is destructive", () => expect(deleteFileTool.annotations.destructiveHint).toBe(true));
    it("is idempotent", () => expect(deleteFileTool.annotations.idempotentHint).toBe(true));
  });

  describe("input schema", () => {
    it("requires name", () => {
      expect(deleteFileTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(false);
    });
    it("dryRun defaults false", () => {
      expect(deleteFileTool.inputSchema.parse({ routerId: "r1", name: "f.txt" }).dryRun).toBe(false);
    });
    it("rejects extra fields", () => {
      expect(deleteFileTool.inputSchema.safeParse({ routerId: "r1", name: "f.txt", extra: true }).success).toBe(false);
    });
  });

  describe("handler", () => {
    it("deletes file when found", async () => {
      const ctx = makeDeleteContext();
      const result = await deleteFileTool.handler({ routerId: "test-router", name: "flash/my-backup.backup" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("deleted");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("file", "*A");
    });

    it("returns not_found gracefully when file missing", async () => {
      const ctx = makeDeleteContext([]);
      const result = await deleteFileTool.handler({ routerId: "test-router", name: "missing.rsc" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("not_found");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeDeleteContext();
      const result = await deleteFileTool.handler(
        { routerId: "test-router", name: "flash/my-backup.backup", dryRun: true },
        ctx,
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("propagates network errors", async () => {
      const ctx = makeDeleteContext();
      (ctx.routerClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(deleteFileTool.handler({ routerId: "test-router", name: "f.txt" }, ctx)).rejects.toThrow();
    });
  });
});

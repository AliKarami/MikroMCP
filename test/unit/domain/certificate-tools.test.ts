import { describe, it, expect, vi, beforeEach } from "vitest";
import { certificateTools } from "../../../src/domain/tools/certificate-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";

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

function makeContext(certs: Record<string, unknown>[] = []): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: {
      id: "superadmin-builtin",
      role: "superadmin" as const,
      allowedRouters: [],
      allowedToolPatterns: [],
    },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue(certs),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listTool, manageTool] = certificateTools;

describe("certificateTools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => expect(certificateTools).toHaveLength(2));

    it("has correct tool names", () => {
      expect(listTool.name).toBe("list_certificates");
      expect(manageTool.name).toBe("manage_certificate");
    });

    it("list_certificates has readOnlyHint: true", () =>
      expect(listTool.annotations.readOnlyHint).toBe(true));

    it("manage_certificate has destructiveHint: true", () =>
      expect(manageTool.annotations.destructiveHint).toBe(true));
  });

  describe("input schema — list_certificates", () => {
    it("parses valid input", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1" });
      expect(result.success).toBe(true);
    });

    it("applies default limit of 100", () => {
      const result = listTool.inputSchema.parse({ routerId: "r1" });
      expect(result.limit).toBe(100);
    });

    it("rejects extra fields", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1", extra: true });
      expect(result.success).toBe(false);
    });

    it("expired field is optional boolean", () => {
      const withExpired = listTool.inputSchema.safeParse({ routerId: "r1", expired: true });
      expect(withExpired.success).toBe(true);
      const withoutExpired = listTool.inputSchema.safeParse({ routerId: "r1" });
      expect(withoutExpired.success).toBe(true);
    });

    it("rejects limit out of range", () => {
      const result = listTool.inputSchema.safeParse({ routerId: "r1", limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe("input schema — manage_certificate", () => {
    it("parses valid remove input", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "remove",
        name: "my-cert",
      });
      expect(result.success).toBe(true);
    });

    it("parses valid trust input", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "trust",
        name: "my-cert",
      });
      expect(result.success).toBe(true);
    });

    it("parses valid untrust input", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "untrust",
        name: "my-cert",
      });
      expect(result.success).toBe(true);
    });

    it("dryRun defaults to false", () => {
      const result = manageTool.inputSchema.parse({
        routerId: "r1",
        action: "remove",
        name: "my-cert",
      });
      expect(result.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "remove",
        name: "my-cert",
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid action", () => {
      const result = manageTool.inputSchema.safeParse({
        routerId: "r1",
        action: "add",
        name: "my-cert",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler — list_certificates", () => {
    it("returns certificates in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "cert1", "common-name": "example.com" },
        { ".id": "*2", name: "cert2", "common-name": "test.com" },
      ]);
      const result = await listTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.certificates as unknown[]).length).toBe(2);
      expect(sc.total).toBe(2);
    });

    it("filters by name substring", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "root-ca", "common-name": "Root CA" },
        { ".id": "*2", name: "server-cert", "common-name": "Server" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", name: "root" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.certificates as unknown[]).length).toBe(1);
    });

    it("filters expired: true keeps only certs with invalid-after in the past", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "old-cert", "invalid-after": "jan/01/2020 00:00:00" },
        { ".id": "*2", name: "new-cert", "invalid-after": "jan/01/2030 00:00:00" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", expired: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const certs = sc.certificates as Record<string, unknown>[];
      expect(certs.length).toBe(1);
      expect(certs[0].name).toBe("old-cert");
    });

    it("filters expired: false keeps only certs with invalid-after in the future", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "old-cert", "invalid-after": "jan/01/2020 00:00:00" },
        { ".id": "*2", name: "new-cert", "invalid-after": "jan/01/2030 00:00:00" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", expired: false }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const certs = sc.certificates as Record<string, unknown>[];
      expect(certs.length).toBe(1);
      expect(certs[0].name).toBe("new-cert");
    });

    it("treats missing invalid-after as expired when filtering expired: true", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "no-expiry-cert" },
        { ".id": "*2", name: "future-cert", "invalid-after": "jan/01/2030 00:00:00" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", expired: true }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const certs = sc.certificates as Record<string, unknown>[];
      expect(certs.length).toBe(1);
      expect(certs[0].name).toBe("no-expiry-cert");
    });

    it("applies limit after filtering", async () => {
      const ctx = makeContext([
        { ".id": "*1", name: "cert1" },
        { ".id": "*2", name: "cert2" },
        { ".id": "*3", name: "cert3" },
      ]);
      const result = await listTool.handler({ routerId: "test-router", limit: 2 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.certificates as unknown[]).length).toBe(2);
      expect(sc.total).toBe(3);
    });
  });

  describe("handler — manage_certificate remove", () => {
    it("removes certificate when found", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "no" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "my-cert" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("certificate", "*1");
    });

    it("throws NOT_FOUND when certificate is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "remove", name: "my-cert" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling remove", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "no" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "remove", name: "my-cert", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_certificate trust", () => {
    it("trusts certificate when untrusted", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "no" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "trust", name: "my-cert" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("trusted");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("certificate", "*1", {
        trusted: "yes",
      });
    });

    it("returns already_trusted when already trusted", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "yes" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "trust", name: "my-cert" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_trusted");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when certificate is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "trust", name: "my-cert" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "no" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "trust", name: "my-cert", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(sc.change).toBe("trusted: no → yes");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("handler — manage_certificate untrust", () => {
    it("untrusts certificate when trusted", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "yes" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "untrust", name: "my-cert" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("untrusted");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("certificate", "*1", {
        trusted: "no",
      });
    });

    it("returns already_untrusted when already untrusted", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "no" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "untrust", name: "my-cert" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_untrusted");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when certificate is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageTool.handler({ routerId: "test-router", action: "untrust", name: "my-cert" }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
    });

    it("dry_run returns preview without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "my-cert", trusted: "yes" }]);
      const result = await manageTool.handler(
        { routerId: "test-router", action: "untrust", name: "my-cert", dryRun: true },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(sc.change).toBe("trusted: yes → no");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });
});

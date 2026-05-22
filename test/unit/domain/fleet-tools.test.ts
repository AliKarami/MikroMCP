import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createFleetTools } from "../../../src/domain/tools/fleet-tools.js";
import type { ToolContext, ToolDefinition } from "../../../src/domain/tools/tool-definition.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { AppConfig } from "../../../src/config/app-config.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

vi.mock("../../../src/middleware/authz.js", () => ({
  checkAuthz: vi.fn(),
}));

vi.mock("../../../src/observability/audit-log.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/observability/audit-log.js")>();
  return { ...actual, auditLog: vi.fn() };
});

vi.mock("../../../src/adapter/adapter-factory.js", () => ({
  createSshClient: vi.fn().mockReturnValue({}),
  createFtpClient: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../src/config/secrets.js", () => ({
  getCredentials: vi.fn().mockReturnValue({ username: "admin", password: "pass" }),
}));

import { checkAuthz } from "../../../src/middleware/authz.js";
import { auditLog } from "../../../src/observability/audit-log.js";

const mockReadTool: ToolDefinition = {
  name: "list_interfaces",
  title: "List Interfaces",
  description: "Test tool",
  inputSchema: z.object({ routerId: z.string() }).strict(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: vi.fn().mockResolvedValue({ content: "ok", structuredContent: { interfaces: [] } }),
};

const mockDestructiveTool: ToolDefinition = {
  name: "reboot",
  title: "Reboot",
  description: "Reboot router",
  inputSchema: z.object({ routerId: z.string() }).strict(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: vi.fn(),
};

const fleetTools = createFleetTools([mockReadTool, mockDestructiveTool]);
const healthTool = fleetTools.find((t) => t.name === "check_router_health")!;
const bulkTool = fleetTools.find((t) => t.name === "bulk_execute")!;

function makeRouterConfig(id = "test-router"): RouterConfig {
  return {
    id,
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
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
    sshClient: {} as SshClient,
    ftpClient: {} as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
    appConfig: { ssh: { commandTimeoutMs: 30000, maxOutputBytes: 524288 } } as unknown as AppConfig,
    ...overrides,
  };
}

function makeFleetContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const mockRegistry = {
    getRouter: vi.fn().mockImplementation((id: string) => makeRouterConfig(id)),
    listRouters: vi.fn().mockReturnValue([makeRouterConfig("r1"), makeRouterConfig("r2"), makeRouterConfig("r3")]),
    hasRouter: vi.fn().mockReturnValue(true),
  };
  const mockPool = {
    getClient: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
    } as unknown as RouterOSRestClient),
  };
  return {
    ...makeContext(),
    routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
    connectionPool: mockPool as unknown as ToolContext["connectionPool"],
    ...overrides,
  };
}

describe("fleet-tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(fleetTools).toHaveLength(2);
    });

    it("tool names are correct", () => {
      const names = fleetTools.map((t) => t.name);
      expect(names).toContain("check_router_health");
      expect(names).toContain("bulk_execute");
    });

    it("check_router_health has readOnlyHint: true", () => {
      expect(healthTool.annotations.readOnlyHint).toBe(true);
      expect(healthTool.annotations.destructiveHint).toBe(false);
    });

    it("bulk_execute has readOnlyHint: false", () => {
      expect(bulkTool.annotations.readOnlyHint).toBe(false);
      expect(bulkTool.annotations.destructiveHint).toBe(false);
    });
  });

  describe("handler — check_router_health", () => {
    it("returns healthy when routerClient.get succeeds", async () => {
      const resource = {
        "version": "7.14",
        "uptime": "1d00:00:00",
        "cpu-load": "5",
        "free-memory": "100000",
        "total-memory": "500000",
      };
      const ctx = makeContext({
        routerClient: {
          get: vi.fn().mockResolvedValue([resource]),
        } as unknown as RouterOSRestClient,
      });

      const result = await healthTool.handler({ routerId: "test-router" }, ctx);

      expect(result.structuredContent).toMatchObject({
        routerId: "test-router",
        healthy: true,
        rosVersion: "7.14",
        uptime: "1d00:00:00",
        cpuLoad: "5",
        freeMemory: "100000",
        totalMemory: "500000",
      });
      expect((result.structuredContent as Record<string, unknown>).latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.content).toContain("is healthy");
    });

    it("returns healthy=false (no throw) when routerClient.get throws", async () => {
      const ctx = makeContext({
        routerClient: {
          get: vi.fn().mockRejectedValue(new Error("Connection refused")),
        } as unknown as RouterOSRestClient,
      });

      const result = await healthTool.handler({ routerId: "test-router" }, ctx);

      expect(result.structuredContent).toMatchObject({
        routerId: "test-router",
        healthy: false,
        error: "Connection refused",
      });
      expect(result.content).toContain("is unhealthy");
    });
  });

  describe("handler — bulk_execute input validation", () => {
    it("throws VALIDATION when toolName is 'bulk_execute'", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler(
          { toolName: "bulk_execute", routerIds: ["r1"], params: {} },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
        code: "BULK_SELF_REFERENCE",
      });
    });

    it("throws VALIDATION when toolName is 'check_router_health'", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler(
          { toolName: "check_router_health", routerIds: ["r1"], params: {} },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
        code: "BULK_SELF_REFERENCE",
      });
    });

    it("throws CONFIGURATION when destructive tool is used and confirmationSecret is not configured", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler({ toolName: "reboot", routerIds: ["r1"], params: {} }, ctx),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFIGURATION,
        code: "FLEET_CONFIRMATION_UNAVAILABLE",
      });
    });

    it("throws VALIDATION when neither routerIds nor tags provided", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler({ toolName: "list_interfaces", params: {} }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BULK_TARGET_REQUIRED" });
    });

    it("throws VALIDATION when both routerIds and tags are empty arrays", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler({ toolName: "list_interfaces", routerIds: [], tags: [], params: {} }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BULK_TARGET_REQUIRED" });
    });

    it("throws VALIDATION when both routerIds and tags are non-empty", async () => {
      const ctx = makeFleetContext();
      await expect(
        bulkTool.handler(
          { toolName: "list_interfaces", routerIds: ["r1"], tags: ["tag1"], params: {} },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BULK_TARGET_REQUIRED" });
    });

    it("accepts tags with empty routerIds array (MCP Inspector default)", async () => {
      const ctx = makeFleetContext();
      const result = await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: [], tags: ["prod"], params: {} },
        ctx,
      );
      expect(result.structuredContent).toMatchObject({ totalRouters: expect.any(Number) });
    });
  });

  describe("handler — bulk_execute fan-out", () => {
    beforeEach(() => {
      vi.mocked(checkAuthz).mockReset();
      vi.mocked(mockReadTool.handler).mockReset();
      vi.mocked(mockReadTool.handler).mockResolvedValue({
        content: "ok",
        structuredContent: { interfaces: [] },
      });
    });

    it("fans out to 3 routers from routerIds", async () => {
      const ctx = makeFleetContext();
      const result = await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: ["r1", "r2", "r3"], params: {}, concurrency: 5 },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        toolName: "list_interfaces",
        totalRouters: 3,
        succeeded: 3,
        failed: 0,
      });
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.results as unknown[]).length).toBe(3);
    });

    it("fans out to routers from tags", async () => {
      const mockRegistry = {
        getRouter: vi.fn(),
        listRouters: vi.fn().mockReturnValue([
          makeRouterConfig("r1"),
          makeRouterConfig("r2"),
        ]),
        hasRouter: vi.fn(),
      };
      const mockPool = {
        getClient: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue([]),
        } as unknown as RouterOSRestClient),
      };
      const ctx = makeContext({
        routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
        connectionPool: mockPool as unknown as ToolContext["connectionPool"],
      });

      const result = await bulkTool.handler(
        { toolName: "list_interfaces", tags: ["edge"], params: {}, concurrency: 5 },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        totalRouters: 2,
        succeeded: 2,
        failed: 0,
      });
      expect(mockRegistry.listRouters).toHaveBeenCalledWith(["edge"]);
    });

    it("unknown routerIds appear as status:error in results", async () => {
      const mockRegistry = {
        getRouter: vi.fn().mockImplementation(() => { throw new Error("not found"); }),
        listRouters: vi.fn().mockReturnValue([]),
        hasRouter: vi.fn(),
      };
      const ctx = makeContext({
        routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
        connectionPool: {} as unknown as ToolContext["connectionPool"],
      });

      const result = await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: ["asghar", "akbar"], params: {} },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        totalRouters: 2,
        succeeded: 0,
        failed: 2,
      });
      const results = result.structuredContent.results as Array<{ routerId: string; status: string; error: string }>;
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ routerId: "asghar", status: "error" });
      expect(results[1]).toMatchObject({ routerId: "akbar", status: "error" });
    });

    it("auth failure per router yields error status for that router", async () => {
      vi.mocked(checkAuthz).mockImplementationOnce(() => {
        throw new MikroMCPError({
          category: ErrorCategory.PERMISSION_DENIED,
          code: "ROUTER_NOT_ALLOWED",
          message: "not allowed",
          recoverability: { retryable: false, suggestedAction: "n/a" },
        });
      });

      const mockPool = {
        getClient: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue([]),
        } as unknown as RouterOSRestClient),
      };
      const mockRegistry = {
        getRouter: vi.fn().mockImplementation((id: string) => makeRouterConfig(id)),
        listRouters: vi.fn(),
        hasRouter: vi.fn(),
      };
      const ctx = makeContext({
        routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
        connectionPool: mockPool as unknown as ToolContext["connectionPool"],
      });

      const result = await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: ["r1", "r2"], params: {}, concurrency: 5 },
        ctx,
      );

      const sc = result.structuredContent as {
        succeeded: number;
        failed: number;
        results: Array<{ routerId: string; status: string }>;
      };
      expect(sc.failed).toBe(1);
      expect(sc.succeeded).toBe(1);
      const failedResult = sc.results.find((r) => r.status === "error");
      expect(failedResult).toBeDefined();
      expect(failedResult!.routerId).toBe("r1");
    });

    it("partial tool handler failures produce correct succeeded/failed counts", async () => {
      vi.mocked(mockReadTool.handler)
        .mockResolvedValueOnce({ content: "ok", structuredContent: {} })
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({ content: "ok", structuredContent: {} });

      const ctx = makeFleetContext();
      const result = await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: ["r1", "r2", "r3"], params: {}, concurrency: 5 },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        totalRouters: 3,
        succeeded: 2,
        failed: 1,
      });
    });

    it("emits audit events for the fan-out and per router", async () => {
      vi.mocked(auditLog).mockClear();
      vi.mocked(mockReadTool.handler).mockResolvedValue({ content: "ok", structuredContent: {} });

      const mockRegistry = {
        getRouter: vi.fn().mockImplementation((id: string) => makeRouterConfig(id)),
        listRouters: vi.fn(),
        hasRouter: vi.fn(),
      };
      const mockPool = {
        getClient: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue([]),
        } as unknown as RouterOSRestClient),
      };
      const ctx = makeContext({
        routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
        connectionPool: mockPool as unknown as ToolContext["connectionPool"],
      });

      await bulkTool.handler(
        { toolName: "list_interfaces", routerIds: ["r1", "r2"], params: {}, concurrency: 5 },
        ctx,
      );

      const calls = vi.mocked(auditLog).mock.calls.map((c) => c[0]);

      // Overall attempt event
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "bulk_execute", phase: "attempt" })]),
      );

      // Overall success event
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "bulk_execute", phase: "success" })]),
      );

      // Per-router events — one per router with the router's id, tool, and phase
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "list_interfaces", routerId: "r1", phase: "success" })]),
      );
      expect(calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "list_interfaces", routerId: "r2", phase: "success" })]),
      );
    });

    it("respects concurrency limit by batching", async () => {
      // With concurrency=2 and 4 routers, should batch into 2 groups of 2
      const mockPool = {
        getClient: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue([]),
        } as unknown as RouterOSRestClient),
      };
      const mockRegistry = {
        getRouter: vi.fn().mockImplementation((id: string) => makeRouterConfig(id)),
        listRouters: vi.fn(),
        hasRouter: vi.fn(),
      };
      const ctx = makeContext({
        routerRegistry: mockRegistry as unknown as ToolContext["routerRegistry"],
        connectionPool: mockPool as unknown as ToolContext["connectionPool"],
      });

      const result = await bulkTool.handler(
        {
          toolName: "list_interfaces",
          routerIds: ["r1", "r2", "r3", "r4"],
          params: {},
          concurrency: 2,
        },
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        totalRouters: 4,
        succeeded: 4,
        failed: 0,
      });
    });
  });

  describe("handler — bulk_execute destructive confirmation", () => {
    function makeFleetContextWithSecret(secret: string | undefined): ToolContext {
      return makeFleetContext({
        appConfig: {
          ssh: { commandTimeoutMs: 30000, maxOutputBytes: 524288 },
          confirmationSecret: secret,
        } as unknown as AppConfig,
      });
    }

    it("returns APPROVAL_REQUIRED with a confirmationToken when no token is provided and secret is set", async () => {
      const ctx = makeFleetContextWithSecret("fleet-secret");
      await expect(
        bulkTool.handler({ toolName: "reboot", routerIds: ["r1", "r2"], params: {} }, ctx),
      ).rejects.toMatchObject({
        category: ErrorCategory.APPROVAL_REQUIRED,
        code: "FLEET_CONFIRMATION_REQUIRED",
        details: expect.objectContaining({ confirmationToken: expect.any(String) }),
      });
    });

    it("fans out the destructive tool when the correct token is provided", async () => {
      vi.mocked(mockDestructiveTool.handler).mockResolvedValue({
        content: "rebooted",
        structuredContent: {},
      });

      const ctx = makeFleetContextWithSecret("fleet-secret");

      // First call — get the token
      let token = "";
      try {
        await bulkTool.handler({ toolName: "reboot", routerIds: ["r1", "r2"], params: {} }, ctx);
      } catch (err) {
        token = (err as MikroMCPError).details!.confirmationToken as string;
      }
      expect(token).toBeTruthy();

      // Second call — re-use same context with matching pool/registry
      const ctx2 = makeFleetContextWithSecret("fleet-secret");
      const result = await bulkTool.handler(
        { toolName: "reboot", routerIds: ["r1", "r2"], params: {}, confirmationToken: token },
        ctx2,
      );

      expect(result.structuredContent).toMatchObject({
        toolName: "reboot",
        totalRouters: 2,
        succeeded: 2,
        failed: 0,
      });
      expect(mockDestructiveTool.handler).toHaveBeenCalledTimes(2);
    });

    it("returns FLEET_CONFIRMATION_UNAVAILABLE when confirmationSecret is not configured", async () => {
      const ctx = makeFleetContextWithSecret(undefined);
      await expect(
        bulkTool.handler({ toolName: "reboot", routerIds: ["r1"], params: {} }, ctx),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFIGURATION,
        code: "FLEET_CONFIRMATION_UNAVAILABLE",
      });
    });
  });
});

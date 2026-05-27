import { describe, it, expect, vi } from "vitest";
import { networkTestTools } from "../../../src/domain/tools/network-test-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";

const BW_RESULT = { "tx-current": "100000000", "rx-current": "50000000", "lost-packets": "0" };
const FETCH_RESULT = { status: "200", data: "Hello World" };
const CONN1 = { ".id": "*1", "src-address": "10.0.0.1:12345", "dst-address": "8.8.8.8:443", protocol: "tcp" };

function makeContext(executeResult: unknown = {}, getResult: unknown[] = []) {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: {} as RouterConfig,
    sshClient: {} as SshClient,
    ftpClient: {} as FtpClient,
    identity: { id: "superadmin-builtin", role: "superadmin" as const, allowedRouters: [], allowedToolPatterns: [] },
    routerClient: {
      execute: vi.fn().mockResolvedValue(executeResult),
      get: vi.fn().mockResolvedValue(getResult),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

const [bandwidthTestTool, fetchUrlTool, listConnectionsTool] = networkTestTools;

describe("networkTestTools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => expect(networkTestTools).toHaveLength(3));
    it("has correct names", () => {
      expect(bandwidthTestTool.name).toBe("bandwidth_test");
      expect(fetchUrlTool.name).toBe("fetch_url");
      expect(listConnectionsTool.name).toBe("list_connections");
    });
    it("all tools are readOnly", () => {
      expect(bandwidthTestTool.annotations.readOnlyHint).toBe(true);
      expect(fetchUrlTool.annotations.readOnlyHint).toBe(true);
      expect(listConnectionsTool.annotations.readOnlyHint).toBe(true);
    });
    it("none are destructive", () => {
      expect(bandwidthTestTool.annotations.destructiveHint).toBe(false);
      expect(fetchUrlTool.annotations.destructiveHint).toBe(false);
      expect(listConnectionsTool.annotations.destructiveHint).toBe(false);
    });
    it("bandwidth_test and fetch_url are not idempotent", () => {
      expect(bandwidthTestTool.annotations.idempotentHint).toBe(false);
      expect(fetchUrlTool.annotations.idempotentHint).toBe(false);
    });
    it("list_connections is idempotent", () => {
      expect(listConnectionsTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("bandwidth_test input schema", () => {
    it("requires address", () => expect(bandwidthTestTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(false));
    it("defaults protocol tcp", () => expect(bandwidthTestTool.inputSchema.parse({ routerId: "r1", address: "10.0.0.1" }).protocol).toBe("tcp"));
    it("defaults direction both", () => expect(bandwidthTestTool.inputSchema.parse({ routerId: "r1", address: "10.0.0.1" }).direction).toBe("both"));
    it("defaults duration 5", () => expect(bandwidthTestTool.inputSchema.parse({ routerId: "r1", address: "10.0.0.1" }).duration).toBe(5));
    it("rejects duration above 30", () => expect(bandwidthTestTool.inputSchema.safeParse({ routerId: "r1", address: "10.0.0.1", duration: 60 }).success).toBe(false));
    it("rejects extra fields", () => expect(bandwidthTestTool.inputSchema.safeParse({ routerId: "r1", address: "10.0.0.1", extra: true }).success).toBe(false));
  });

  describe("bandwidth_test handler", () => {
    it("calls tool/bandwidth-test and returns throughput", async () => {
      const ctx = makeContext(BW_RESULT);
      const result = await bandwidthTestTool.handler({ routerId: "test-router", address: "10.0.0.2" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.txMbps).toBeDefined();
      expect(sc.rxMbps).toBeDefined();
      expect(sc.lostPackets).toBe("0");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "tool/bandwidth-test",
        expect.objectContaining({ address: "10.0.0.2", protocol: "tcp", direction: "both" }),
      );
    });

    it("propagates errors", async () => {
      const ctx = makeContext();
      (ctx.routerClient.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
      await expect(bandwidthTestTool.handler({ routerId: "test-router", address: "10.0.0.2" }, ctx)).rejects.toThrow();
    });
  });

  describe("fetch_url input schema", () => {
    it("requires url", () => expect(fetchUrlTool.inputSchema.safeParse({ routerId: "r1" }).success).toBe(false));
    it("defaults method GET", () => expect(fetchUrlTool.inputSchema.parse({ routerId: "r1", url: "http://example.com" }).method).toBe("GET"));
    it("rejects extra fields", () => expect(fetchUrlTool.inputSchema.safeParse({ routerId: "r1", url: "http://x.com", extra: true }).success).toBe(false));
  });

  describe("fetch_url handler", () => {
    it("calls tool/fetch and returns status + body", async () => {
      const ctx = makeContext(FETCH_RESULT);
      const result = await fetchUrlTool.handler({ routerId: "test-router", url: "http://example.com" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.statusCode).toBe("200");
      expect(sc.body).toBe("Hello World");
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "tool/fetch",
        expect.objectContaining({ url: "http://example.com", "http-method": "get" }),
      );
    });

    it("returns outputFile path instead of body when outputFile provided", async () => {
      const ctx = makeContext({ status: "200" });
      const result = await fetchUrlTool.handler({ routerId: "test-router", url: "http://example.com", outputFile: "flash/response.txt" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.outputFile).toBe("flash/response.txt");
      expect(sc.body).toBeUndefined();
      expect(ctx.routerClient.execute).toHaveBeenCalledWith(
        "tool/fetch",
        expect.objectContaining({ output: "flash/response.txt" }),
      );
    });

    it("truncates body over 64KB", async () => {
      const bigBody = "x".repeat(70000);
      const ctx = makeContext({ status: "200", data: bigBody });
      const result = await fetchUrlTool.handler({ routerId: "test-router", url: "http://example.com" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.body as string).length).toBeLessThanOrEqual(65537 + 15);
      expect(sc.body as string).toContain("[TRUNCATED]");
    });
  });

  describe("list_connections", () => {
    it("returns all connections without filter", async () => {
      const ctx = makeContext({}, [CONN1, { ".id": "*2", "src-address": "10.0.0.2:9000", "dst-address": "1.1.1.1:80", protocol: "tcp" }]);
      const result = await listConnectionsTool.handler({ routerId: "test-router" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).connections as unknown[]).length).toBe(2);
    });

    it("filters by protocol", async () => {
      const ctx = makeContext({}, [CONN1, { ".id": "*2", "src-address": "10.0.0.2:9000", "dst-address": "1.1.1.1:53", protocol: "udp" }]);
      const result = await listConnectionsTool.handler({ routerId: "test-router", protocol: "tcp" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).connections as unknown[]).length).toBe(1);
    });

    it("filters by srcAddress substring", async () => {
      const ctx = makeContext({}, [CONN1, { ".id": "*2", "src-address": "192.168.1.5:8080", "dst-address": "1.1.1.1:80", protocol: "tcp" }]);
      const result = await listConnectionsTool.handler({ routerId: "test-router", srcAddress: "192.168" }, ctx);
      expect(((result.structuredContent as Record<string, unknown>).connections as unknown[]).length).toBe(1);
    });
  });
});

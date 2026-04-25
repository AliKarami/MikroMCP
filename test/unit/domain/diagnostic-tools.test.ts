import { describe, it, expect, vi } from "vitest";
import { diagnosticTools } from "../../../src/domain/tools/diagnostic-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import { z } from "zod";

const pingTool = diagnosticTools[0];
const tracerouteTool = diagnosticTools[1];

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

function makeContext(executeReturn: unknown = []): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    routerClient: {
      execute: vi.fn().mockResolvedValue(executeReturn),
    } as unknown as RouterOSRestClient,
  };
}

const pingInputSchema = z.object({
  routerId: z.string(),
  address: z.string(),
  count: z.number().int().min(1).max(20).default(4),
  size: z.number().int().min(14).max(65535).default(56),
  routingTable: z.string().optional(),
}).strict();

const tracerouteInputSchema = z.object({
  routerId: z.string(),
  address: z.string(),
  count: z.number().int().min(1).max(5).default(3),
  maxHops: z.number().int().min(1).max(30).default(15),
}).strict();

describe("diagnostic tools", () => {
  describe("metadata", () => {
    it("exports at least 2 tools: ping and traceroute as first two", () => {
      expect(diagnosticTools.length).toBeGreaterThanOrEqual(2);
      expect(pingTool.name).toBe("ping");
      expect(tracerouteTool.name).toBe("traceroute");
    });

    it("ping has correct annotations", () => {
      expect(pingTool.annotations.readOnlyHint).toBe(true);
      expect(pingTool.annotations.destructiveHint).toBe(false);
      expect(pingTool.annotations.idempotentHint).toBe(true);
    });

    it("traceroute has correct annotations", () => {
      expect(tracerouteTool.annotations.readOnlyHint).toBe(true);
      expect(tracerouteTool.annotations.destructiveHint).toBe(false);
    });
  });

  describe("ping input schema", () => {
    it("accepts minimal input with defaults", () => {
      const r = pingInputSchema.parse({ routerId: "r", address: "8.8.8.8" });
      expect(r.count).toBe(4);
      expect(r.size).toBe(56);
    });

    it("rejects count > 20", () => {
      expect(() => pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", count: 21 })).toThrow();
    });

    it("rejects size < 14", () => {
      expect(() => pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", size: 13 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => pingInputSchema.parse({ routerId: "r", address: "8.8.8.8", unknown: true })).toThrow();
    });
  });

  describe("traceroute input schema", () => {
    it("accepts minimal input with defaults", () => {
      const r = tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8" });
      expect(r.count).toBe(3);
      expect(r.maxHops).toBe(15);
    });

    it("rejects maxHops > 30", () => {
      expect(() => tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8", maxHops: 31 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => tracerouteInputSchema.parse({ routerId: "r", address: "8.8.8.8", extra: 1 })).toThrow();
    });
  });

  describe("ping handler", () => {
    const pingResult = [
      { host: "8.8.8.8", sent: "4", received: "4", "packet-loss": "0%", "min-rtt": "10ms", "avg-rtt": "12ms", "max-rtt": "15ms" },
    ];

    it("returns RTT stats on successful ping", async () => {
      const ctx = makeContext(pingResult);
      const result = await pingTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("8.8.8.8");
      expect((result.structuredContent as Record<string, unknown>).routerId).toBe("test-router");
    });

    it("calls execute with tool/ping path", async () => {
      const ctx = makeContext(pingResult);
      await pingTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect((ctx.routerClient as Record<string, unknown>).execute).toHaveBeenCalledWith(
        "tool/ping",
        expect.objectContaining({ address: "8.8.8.8" }),
      );
    });

    it("passes count and size to execute", async () => {
      const ctx = makeContext(pingResult);
      await pingTool.handler({ routerId: "test-router", address: "10.0.0.1", count: 10, size: 128 }, ctx);
      expect((ctx.routerClient as Record<string, unknown>).execute).toHaveBeenCalledWith(
        "tool/ping",
        expect.objectContaining({ count: "10", "packet-size": "128" }),
      );
    });

    it("treats 100% packet loss as a valid (non-error) response", async () => {
      const lossResult = [
        { host: "10.255.255.1", sent: "4", received: "0", "packet-loss": "100%", "min-rtt": "", "avg-rtt": "", "max-rtt": "" },
      ];
      const ctx = makeContext(lossResult);
      const result = await pingTool.handler({ routerId: "test-router", address: "10.255.255.1" }, ctx);
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("100%");
    });
  });

  describe("traceroute handler", () => {
    const traceResult = [
      { address: "192.168.1.1", loss: "0%", "sent": "3", "last": "1ms", "avg": "1ms", "best": "1ms", "worst": "1ms" },
      { address: "10.0.0.1", loss: "0%", "sent": "3", "last": "5ms", "avg": "5ms", "best": "4ms", "worst": "6ms" },
    ];

    it("returns hop list", async () => {
      const ctx = makeContext(traceResult);
      const result = await tracerouteTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.hops as unknown[]).length).toBe(2);
    });

    it("calls execute with tool/traceroute path", async () => {
      const ctx = makeContext(traceResult);
      await tracerouteTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect((ctx.routerClient as Record<string, unknown>).execute).toHaveBeenCalledWith(
        "tool/traceroute",
        expect.objectContaining({ address: "8.8.8.8" }),
      );
    });

    it("treats partial hop list (some timeouts) as valid response", async () => {
      const partialResult = [
        { address: "192.168.1.1", loss: "0%", "sent": "3", "last": "1ms", "avg": "1ms", "best": "1ms", "worst": "1ms" },
        { address: "???", loss: "100%", "sent": "3", "last": "", "avg": "", "best": "", "worst": "" },
      ];
      const ctx = makeContext(partialResult);
      const result = await tracerouteTool.handler({ routerId: "test-router", address: "8.8.8.8" }, ctx);
      expect(result.isError).toBeFalsy();
    });
  });
});

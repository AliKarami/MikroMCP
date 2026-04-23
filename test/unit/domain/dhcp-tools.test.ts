import { describe, it, expect, vi, type MockedFunction } from "vitest";
import { dhcpTools } from "../../../src/domain/tools/dhcp-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const tool = dhcpTools[0];

// Inline schema for isolated validation tests (avoids importing internal implementation detail)
const listDhcpInputSchema = z.object({
  routerId: z.string(),
  server: z.string().optional(),
  status: z.enum(["bound", "waiting", "offered", "blocked", "all"]).default("all"),
  macAddress: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

function makeContext(leases: Record<string, unknown>[]): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(leases);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: { get: mockGet } as unknown as RouterOSRestClient,
  };
}

describe("list_dhcp_leases tool", () => {
  describe("metadata", () => {
    it("has correct name and annotations", () => {
      expect(tool.name).toBe("list_dhcp_leases");
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.idempotentHint).toBe(true);
      expect(tool.annotations.openWorldHint).toBe(false);
    });
  });

  describe("input schema", () => {
    it("accepts minimal input with correct defaults", () => {
      const r = listDhcpInputSchema.parse({ routerId: "core-01" });
      expect(r.status).toBe("all");
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(0);
    });

    it("accepts all optional fields", () => {
      const r = listDhcpInputSchema.parse({
        routerId: "core-01",
        server: "dhcp1",
        status: "bound",
        macAddress: "AA:BB:CC:DD:EE:FF",
        limit: 50,
        offset: 10,
      });
      expect(r.server).toBe("dhcp1");
      expect(r.status).toBe("bound");
      expect(r.limit).toBe(50);
    });

    it("rejects unknown status", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", status: "expired" })).toThrow();
    });

    it("rejects limit 0 and 501", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", limit: 0 })).toThrow();
      expect(() => listDhcpInputSchema.parse({ routerId: "r", limit: 501 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listDhcpInputSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("handler", () => {
    const sampleLeases = [
      { ".id": "*1", address: "192.168.1.10", "mac-address": "AA:BB:CC:DD:EE:01", "host-name": "laptop", server: "dhcp1", status: "bound" },
      { ".id": "*2", address: "192.168.1.11", "mac-address": "AA:BB:CC:DD:EE:02", server: "dhcp1", status: "waiting" },
      { ".id": "*3", address: "192.168.1.12", "mac-address": "AA:BB:CC:DD:EE:03", "host-name": "phone", server: "dhcp2", status: "bound" },
    ];

    it("returns all leases with no filters", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await tool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Record<string, unknown>).total).toBe(3);
      expect(((result.structuredContent as Record<string, unknown>).leases as unknown[]).length).toBe(3);
    });

    it("filters by status", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await tool.handler({ routerId: "test-router", status: "bound" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(2);
    });

    it("filters by server", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await tool.handler({ routerId: "test-router", server: "dhcp2" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(1);
    });

    it("filters by macAddress (case-insensitive)", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await tool.handler({ routerId: "test-router", macAddress: "aa:bb:cc:dd:ee:01" }, ctx);
      expect((result.structuredContent as Record<string, unknown>).total).toBe(1);
    });

    it("paginates and sets hasMore", async () => {
      const ctx = makeContext(sampleLeases);
      const result = await tool.handler({ routerId: "test-router", limit: 2, offset: 0 }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(3);
      expect((sc.leases as unknown[]).length).toBe(2);
      expect(sc.hasMore).toBe(true);
    });

    it("formats host-name in content when present", async () => {
      const ctx = makeContext([sampleLeases[0]]);
      const result = await tool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).toContain("laptop");
    });

    it("omits host-name in content when missing", async () => {
      const ctx = makeContext([sampleLeases[1]]);
      const result = await tool.handler({ routerId: "test-router" }, ctx);
      expect(result.content).not.toContain("undefined");
      expect(result.content).not.toContain("()");
    });
  });
});

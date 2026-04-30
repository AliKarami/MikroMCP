import { describe, it, expect, vi } from "vitest";
import { routingProtocolTools } from "../../../src/domain/tools/routing-protocol-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { z } from "zod";

const listBgpPeersTool = routingProtocolTools[0];
const listOspfNeighborsTool = routingProtocolTools[1];

const listBgpSchema = z.object({ routerId: z.string(), state: z.string().optional() }).strict();
const listOspfSchema = z.object({ routerId: z.string(), state: z.string().optional() }).strict();

function makeContext(records: Record<string, unknown>[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
    } as unknown as RouterOSRestClient,
  };
}

describe("routing protocol tools", () => {
  describe("metadata", () => {
    it("exports 2 tools", () => {
      expect(routingProtocolTools).toHaveLength(2);
      expect(listBgpPeersTool.name).toBe("list_bgp_peers");
      expect(listOspfNeighborsTool.name).toBe("list_ospf_neighbors");
    });

    it("both tools have readOnlyHint true and destructiveHint false", () => {
      expect(listBgpPeersTool.annotations.readOnlyHint).toBe(true);
      expect(listBgpPeersTool.annotations.destructiveHint).toBe(false);
      expect(listOspfNeighborsTool.annotations.readOnlyHint).toBe(true);
      expect(listOspfNeighborsTool.annotations.destructiveHint).toBe(false);
    });
  });

  describe("list_bgp_peers input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listBgpSchema.parse({ routerId: "r" })).not.toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listBgpSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("list_ospf_neighbors input schema", () => {
    it("accepts minimal input", () => {
      expect(() => listOspfSchema.parse({ routerId: "r" })).not.toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => listOspfSchema.parse({ routerId: "r", unknownField: true })).toThrow();
    });
  });

  describe("list_bgp_peers handler", () => {
    const sessions = [
      { ".id": "*1", "remote.as": "65001", "remote.address": "10.0.0.1", state: "established", uptime: "1d2h" },
      { ".id": "*2", "remote.as": "65002", "remote.address": "10.0.0.2", state: "active", uptime: "0s" },
    ];

    it("returns all sessions with correct total", async () => {
      const ctx = makeContext(sessions);
      const result = await listBgpPeersTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
    });

    it("filters by state", async () => {
      const ctx = makeContext(sessions);
      const result = await listBgpPeersTool.handler({ routerId: "test-router", state: "established" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
      expect((sc.sessions as Record<string, unknown>[])[0]["remote.as"]).toBe("65001");
    });

    it("calls get with correct ROS 7 path", async () => {
      const ctx = makeContext([]);
      await listBgpPeersTool.handler({ routerId: "test-router" }, ctx);
      const mockGet = (ctx.routerClient as Record<string, unknown>).get as ReturnType<typeof vi.fn>;
      expect(mockGet).toHaveBeenCalledWith("routing/bgp/session", expect.any(Object));
    });
  });

  describe("list_ospf_neighbors handler", () => {
    const neighbors = [
      { ".id": "*1", "neighbor-id": "1.1.1.1", interface: "ether1", state: "full", uptime: "5h" },
      { ".id": "*2", "neighbor-id": "2.2.2.2", interface: "ether2", state: "2-way", uptime: "1h" },
    ];

    it("returns all neighbors with correct total", async () => {
      const ctx = makeContext(neighbors);
      const result = await listOspfNeighborsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(2);
    });

    it("filters by state", async () => {
      const ctx = makeContext(neighbors);
      const result = await listOspfNeighborsTool.handler({ routerId: "test-router", state: "full" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.total).toBe(1);
    });

    it("calls get with correct ROS 7 path", async () => {
      const ctx = makeContext([]);
      await listOspfNeighborsTool.handler({ routerId: "test-router" }, ctx);
      const mockGet = (ctx.routerClient as Record<string, unknown>).get as ReturnType<typeof vi.fn>;
      expect(mockGet).toHaveBeenCalledWith("routing/ospf/neighbor", expect.any(Object));
    });
  });
});

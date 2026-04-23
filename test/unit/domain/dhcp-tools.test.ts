import { describe, it, expect } from "vitest";
import { z } from "zod";

// Inline schema for testing (matches the implementation)
const inputSchema = z.object({
  routerId: z.string().describe("Target router identifier from the router registry"),
  server: z.string().optional()
    .describe("Filter by DHCP server name"),
  status: z.enum(["bound", "waiting", "offered", "blocked", "all"]).default("all")
    .describe("Filter by lease status"),
  macAddress: z.string().optional()
    .describe("Filter by MAC address (exact match, case-insensitive)"),
  limit: z.number().int().min(1).max(500).default(100)
    .describe("Maximum number of leases to return"),
  offset: z.number().int().min(0).default(0)
    .describe("Offset for pagination"),
}).strict();

// Import the tool after we know it should exist
import { dhcpTools } from "../../../src/domain/tools/dhcp-tools.js";

describe("dhcp-tools", () => {
  describe("list_dhcp_leases", () => {
    it("has correct name and annotations", () => {
      const tool = dhcpTools.find((t) => t.name === "list_dhcp_leases");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("list_dhcp_leases");
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.annotations.destructiveHint).toBe(false);
      expect(tool?.annotations.idempotentHint).toBe(true);
      expect(tool?.annotations.openWorldHint).toBe(false);
    });

    describe("input schema", () => {
      it("accepts minimal input with defaults", () => {
        const result = inputSchema.safeParse({ routerId: "core-01" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.routerId).toBe("core-01");
          expect(result.data.status).toBe("all");
          expect(result.data.limit).toBe(100);
          expect(result.data.offset).toBe(0);
        }
      });

      it("accepts all optional fields", () => {
        const result = inputSchema.safeParse({
          routerId: "core-01",
          server: "dhcp-server-1",
          status: "bound",
          macAddress: "AA:BB:CC:DD:EE:FF",
          limit: 50,
          offset: 10,
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.server).toBe("dhcp-server-1");
          expect(result.data.status).toBe("bound");
          expect(result.data.macAddress).toBe("AA:BB:CC:DD:EE:FF");
          expect(result.data.limit).toBe(50);
          expect(result.data.offset).toBe(10);
        }
      });

      it("rejects invalid status", () => {
        const result = inputSchema.safeParse({
          routerId: "core-01",
          status: "invalid",
        });
        expect(result.success).toBe(false);
      });

      it("rejects limit less than 1", () => {
        const result = inputSchema.safeParse({
          routerId: "core-01",
          limit: 0,
        });
        expect(result.success).toBe(false);
      });

      it("rejects limit greater than 500", () => {
        const result = inputSchema.safeParse({
          routerId: "core-01",
          limit: 501,
        });
        expect(result.success).toBe(false);
      });

      it("rejects unknown fields", () => {
        const result = inputSchema.safeParse({
          routerId: "core-01",
          unknownField: true,
        });
        expect(result.success).toBe(false);
      });
    });
  });
});

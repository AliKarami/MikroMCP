import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ipTools } from "../../../src/domain/tools/ip-tools.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";

const manageIpAddressTool = ipTools.find((t) => t.name === "manage_ip_address")!;

// Inline schema for isolated validation tests
const manageIpAddressInputSchema = z
  .object({
    routerId: z.string(),
    action: z.enum(["add", "update", "remove"]),
    address: z
      .string()
      .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/)
      .transform((v) => (v.includes("/") ? v : `${v}/32`)),
    interface: z.string(),
    network: z.string().optional(),
    comment: z.string().max(255).optional(),
    disabled: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();

function makeContext(
  addresses: Record<string, unknown>[],
  createReturn?: Record<string, unknown>,
): ToolContext {
  const mockGet = vi.fn().mockResolvedValue(addresses);
  const mockCreate = vi
    .fn()
    .mockResolvedValue(createReturn ?? { ".id": "*1", address: "192.0.2.1/24" });
  const mockUpdate = vi.fn().mockResolvedValue(undefined);
  const mockRemove = vi.fn().mockResolvedValue(undefined);
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: mockGet,
      create: mockCreate,
      update: mockUpdate,
      remove: mockRemove,
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

const sampleAddress = {
  ".id": "*1",
  address: "192.0.2.1/24",
  interface: "ether1",
  disabled: "false",
  comment: "itest",
};

const baseParams = {
  routerId: "test-router",
  address: "192.0.2.1/24",
  interface: "ether1",
};

describe("ip tools", () => {
  describe("metadata", () => {
    it("exports manage_ip_address", () => {
      expect(ipTools.map((t) => t.name)).toContain("manage_ip_address");
    });

    it("manage_ip_address has correct annotations", () => {
      expect(manageIpAddressTool.annotations.readOnlyHint).toBe(false);
      expect(manageIpAddressTool.annotations.destructiveHint).toBe(true);
      expect(manageIpAddressTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("manage_ip_address input schema", () => {
    it("accepts valid add action with defaults", () => {
      const parsed = manageIpAddressInputSchema.parse({
        routerId: "r1",
        action: "add",
        address: "10.0.0.1/24",
        interface: "ether1",
      });
      expect(parsed.disabled).toBe(false);
      expect(parsed.dryRun).toBe(false);
    });

    it("transforms a plain IP to /32", () => {
      const parsed = manageIpAddressInputSchema.parse({
        routerId: "r1",
        action: "add",
        address: "10.0.0.1",
        interface: "ether1",
      });
      expect(parsed.address).toBe("10.0.0.1/32");
    });

    it("rejects extra fields", () => {
      expect(() =>
        manageIpAddressInputSchema.parse({
          routerId: "r1",
          action: "add",
          address: "10.0.0.1/24",
          interface: "ether1",
          extra: true,
        }),
      ).toThrow();
    });
  });

  describe("manage_ip_address handler - add action", () => {
    it("creates the address when no match found", async () => {
      const ctx = makeContext([]);
      const result = await manageIpAddressTool.handler({ ...baseParams, action: "add" }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "created");
      expect((ctx.routerClient as Record<string, unknown>).create).toHaveBeenCalledWith(
        "ip/address",
        expect.objectContaining({ address: "192.0.2.1/24", interface: "ether1" }),
      );
    });

    it("returns already_exists when match found with same config", async () => {
      const ctx = makeContext([sampleAddress]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "add", comment: "itest" },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });

    it("returns already_exists when the record carries a parsed boolean disabled field", async () => {
      const ctx = makeContext([{ ...sampleAddress, disabled: false }]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "add", comment: "itest" },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "already_exists");
    });

    it("throws CONFLICT when match found with different config", async () => {
      const ctx = makeContext([sampleAddress]);
      const error = await manageIpAddressTool
        .handler({ ...baseParams, action: "add", comment: "different" }, ctx)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MikroMCPError);
      expect((error as MikroMCPError).code).toBe("IP_ADDRESS_CONFLICT");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });

    it("returns dry_run without creating when dryRun is true", async () => {
      const ctx = makeContext([]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "add", dryRun: true },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      expect((ctx.routerClient as Record<string, unknown>).create).not.toHaveBeenCalled();
    });
  });

  describe("manage_ip_address handler - update action", () => {
    it("returns no_change when the requested config matches", async () => {
      const ctx = makeContext([sampleAddress]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "update", comment: "itest", disabled: false },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "no_change");
      expect((ctx.routerClient as Record<string, unknown>).update).not.toHaveBeenCalled();
    });

    it("returns no_change when the record carries a parsed boolean disabled field", async () => {
      // The response parser converts "false" to boolean false — the change
      // detection must not report a spurious disabled update.
      const ctx = makeContext([{ ...sampleAddress, disabled: false }]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "update", comment: "itest", disabled: false },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "no_change");
      expect((ctx.routerClient as Record<string, unknown>).update).not.toHaveBeenCalled();
    });

    it("updates when disabled actually differs", async () => {
      const ctx = makeContext([{ ...sampleAddress, disabled: false }]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "update", comment: "itest", disabled: true },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "updated");
      expect((ctx.routerClient as Record<string, unknown>).update).toHaveBeenCalledWith(
        "ip/address",
        "*1",
        { disabled: "true" },
      );
    });

    it("returns dry_run without updating when dryRun is true", async () => {
      const ctx = makeContext([sampleAddress]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "update", comment: "changed", dryRun: true },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      expect((ctx.routerClient as Record<string, unknown>).update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when no match exists", async () => {
      const ctx = makeContext([]);
      const error = await manageIpAddressTool
        .handler({ ...baseParams, action: "update", comment: "x" }, ctx)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MikroMCPError);
      expect((error as MikroMCPError).code).toBe("IP_ADDRESS_NOT_FOUND");
    });
  });

  describe("manage_ip_address handler - remove action", () => {
    it("removes the address when match found", async () => {
      const ctx = makeContext([sampleAddress]);
      const result = await manageIpAddressTool.handler({ ...baseParams, action: "remove" }, ctx);
      expect(result.structuredContent).toHaveProperty("action", "removed");
      expect((ctx.routerClient as Record<string, unknown>).remove).toHaveBeenCalledWith(
        "ip/address",
        "*1",
      );
    });

    it("returns dry_run without removing when dryRun is true", async () => {
      const ctx = makeContext([sampleAddress]);
      const result = await manageIpAddressTool.handler(
        { ...baseParams, action: "remove", dryRun: true },
        ctx,
      );
      expect(result.structuredContent).toHaveProperty("action", "dry_run");
      expect((ctx.routerClient as Record<string, unknown>).remove).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when no match exists", async () => {
      const ctx = makeContext([]);
      const error = await manageIpAddressTool
        .handler({ ...baseParams, action: "remove" }, ctx)
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MikroMCPError);
      expect((error as MikroMCPError).code).toBe("IP_ADDRESS_NOT_FOUND");
    });
  });
});

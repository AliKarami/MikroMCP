import { describe, it, expect, vi } from "vitest";
import { systemOpsTools } from "../../../src/domain/tools/system-ops-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import { z } from "zod";

function makeRouterConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
    ...overrides,
  };
}

function makeContext(overrides: {
  get?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  routerConfig?: RouterConfig;
} = {}): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerConfig: overrides.routerConfig ?? makeRouterConfig(),
    credentials: { username: "admin", password: "secret" },
    routerClient: {
      get: overrides.get ?? vi.fn().mockResolvedValue([]),
      update: overrides.update ?? vi.fn().mockResolvedValue(undefined),
      execute: overrides.execute ?? vi.fn().mockResolvedValue({}),
      create: overrides.create ?? vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: overrides.remove ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const getSystemClockTool = systemOpsTools[0];
const setSystemClockTool = systemOpsTools[1];

describe("system-ops tools", () => {
  describe("metadata", () => {
    it("exports at least 4 tools", () => {
      expect(systemOpsTools.length).toBeGreaterThanOrEqual(4);
    });

    it("get_system_clock is first, set_system_clock is second", () => {
      expect(getSystemClockTool.name).toBe("get_system_clock");
      expect(setSystemClockTool.name).toBe("set_system_clock");
    });

    it("get_system_clock has readOnlyHint true", () => {
      expect(getSystemClockTool.annotations.readOnlyHint).toBe(true);
      expect(getSystemClockTool.annotations.destructiveHint).toBe(false);
    });

    it("set_system_clock has readOnlyHint false and idempotentHint true", () => {
      expect(setSystemClockTool.annotations.readOnlyHint).toBe(false);
      expect(setSystemClockTool.annotations.destructiveHint).toBe(false);
      expect(setSystemClockTool.annotations.idempotentHint).toBe(true);
    });
  });

  describe("set_system_clock input schema", () => {
    const setClockSchema = z.object({
      routerId: z.string(),
      date: z.string().optional(),
      time: z.string().optional(),
      timeZoneName: z.string().optional(),
      dryRun: z.boolean().default(false),
    }).strict();

    it("accepts minimal input (just routerId)", () => {
      const r = setClockSchema.parse({ routerId: "r" });
      expect(r.dryRun).toBe(false);
    });

    it("rejects extra fields", () => {
      expect(() => setClockSchema.parse({ routerId: "r", unknown: 1 })).toThrow();
    });
  });

  describe("get_system_clock handler", () => {
    const clockRecord = [{
      ".id": "*1",
      date: "apr/25/2026",
      time: "12:00:00",
      "time-zone-name": "UTC",
      "time-zone-autodetect": "false",
    }];

    it("returns clock fields", async () => {
      const ctx = makeContext({ get: vi.fn().mockResolvedValue(clockRecord) });
      const result = await getSystemClockTool.handler({ routerId: "test-router" }, ctx);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.date).toBe("apr/25/2026");
      expect(sc.time).toBe("12:00:00");
      expect(sc.timeZoneName).toBe("UTC");
    });

    it("calls GET system/clock", async () => {
      const mockGet = vi.fn().mockResolvedValue(clockRecord);
      const ctx = makeContext({ get: mockGet });
      await getSystemClockTool.handler({ routerId: "test-router" }, ctx);
      expect(mockGet).toHaveBeenCalledWith("system/clock");
    });
  });

  describe("set_system_clock handler", () => {
    const currentClock = [{
      ".id": "*1",
      date: "apr/25/2026",
      time: "12:00:00",
      "time-zone-name": "UTC",
    }];

    it("returns already_set when values match", async () => {
      const mockGet = vi.fn().mockResolvedValue(currentClock);
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ get: mockGet, update: mockUpdate });
      const result = await setSystemClockTool.handler({
        routerId: "test-router",
        date: "apr/25/2026",
        time: "12:00:00",
        timeZoneName: "UTC",
      }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("already_set");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("returns dry_run result without calling update", async () => {
      const mockGet = vi.fn().mockResolvedValue(currentClock);
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ get: mockGet, update: mockUpdate });
      const result = await setSystemClockTool.handler({
        routerId: "test-router",
        timeZoneName: "Europe/London",
        dryRun: true,
      }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("calls update when values differ", async () => {
      const mockGet = vi.fn().mockResolvedValue(currentClock);
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ get: mockGet, update: mockUpdate });
      await setSystemClockTool.handler({
        routerId: "test-router",
        timeZoneName: "Europe/London",
      }, ctx);
      expect(mockUpdate).toHaveBeenCalledWith(
        "system/clock",
        "*1",
        expect.objectContaining({ "time-zone-name": "Europe/London" }),
      );
    });
  });

  describe("reboot metadata and schema", () => {
    const rebootTool = systemOpsTools[2];

    it("reboot is the third tool", () => {
      expect(rebootTool.name).toBe("reboot");
    });

    it("has destructiveHint true", () => {
      expect(rebootTool.annotations.destructiveHint).toBe(true);
      expect(rebootTool.annotations.readOnlyHint).toBe(false);
    });
  });

  describe("reboot input schema", () => {
    const rebootSchema = z.object({
      routerId: z.string(),
      delay: z.number().int().min(0).max(3600).default(0),
      dryRun: z.boolean().default(false),
    }).strict();

    it("accepts minimal input with defaults", () => {
      const r = rebootSchema.parse({ routerId: "r" });
      expect(r.delay).toBe(0);
      expect(r.dryRun).toBe(false);
    });

    it("rejects delay > 3600", () => {
      expect(() => rebootSchema.parse({ routerId: "r", delay: 3601 })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => rebootSchema.parse({ routerId: "r", unknown: 1 })).toThrow();
    });
  });

  describe("reboot handler", () => {
    it("returns dry_run result without calling execute", async () => {
      const mockExecute = vi.fn();
      const ctx = makeContext({ execute: mockExecute });
      const rebootTool = systemOpsTools[2];
      const result = await rebootTool.handler({ routerId: "test-router", dryRun: true }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("calls execute with system/reboot on actual reboot (delay=0)", async () => {
      const mockExecute = vi.fn().mockResolvedValue({});
      const ctx = makeContext({ execute: mockExecute });
      const rebootTool = systemOpsTools[2];
      const result = await rebootTool.handler({ routerId: "test-router" }, ctx);
      expect(mockExecute).toHaveBeenCalledWith("system/reboot", expect.anything());
      expect((result.structuredContent as Record<string, unknown>).action).toBe("rebooting");
    });

    it("includes delay in structured content", async () => {
      const mockExecute = vi.fn().mockResolvedValue({});
      const ctx = makeContext({ execute: mockExecute });
      const rebootTool = systemOpsTools[2];
      const result = await rebootTool.handler({ routerId: "test-router", delay: 30 }, ctx);
      expect((result.structuredContent as Record<string, unknown>).delay).toBe(30);
    });
  });

  describe("run_command metadata and schema", () => {
    const runCommandTool = systemOpsTools[3];

    it("run_command is the fourth tool", () => {
      expect(runCommandTool.name).toBe("run_command");
    });

    it("has destructiveHint true and readOnlyHint false", () => {
      expect(runCommandTool.annotations.destructiveHint).toBe(true);
      expect(runCommandTool.annotations.readOnlyHint).toBe(false);
    });
  });

  describe("run_command input schema", () => {
    const runCommandSchema = z.object({
      routerId: z.string(),
      command: z.string().min(1),
      dryRun: z.boolean().default(false),
    }).strict();

    it("accepts valid input", () => {
      const r = runCommandSchema.parse({ routerId: "r", command: "/ip/route/print" });
      expect(r.dryRun).toBe(false);
    });

    it("rejects empty command", () => {
      expect(() => runCommandSchema.parse({ routerId: "r", command: "" })).toThrow();
    });

    it("rejects extra fields", () => {
      expect(() => runCommandSchema.parse({ routerId: "r", command: "/ip/route/print", extra: 1 })).toThrow();
    });
  });

  describe("run_command handler", () => {
    const runCommandTool = systemOpsTools[3];

    it("throws MikroMCPError for denied command (/system shutdown)", async () => {
      const ctx = makeContext();
      await expect(
        runCommandTool.handler({ routerId: "test-router", command: "/system shutdown" }, ctx),
      ).rejects.toBeInstanceOf(MikroMCPError);
    });

    it("throws MikroMCPError for /system reboot and includes reboot in alternativeTools", async () => {
      const ctx = makeContext();
      try {
        await runCommandTool.handler({ routerId: "test-router", command: "/system reboot" }, ctx);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MikroMCPError);
        expect((err as MikroMCPError).recoverability.alternativeTools).toContain("reboot");
      }
    });

    it("returns dry_run without executing SSH when dryRun=true", async () => {
      const ctx = makeContext();
      const result = await runCommandTool.handler({
        routerId: "test-router",
        command: "/ip/route/print",
        dryRun: true,
      }, ctx);
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
    });

    it("throws for per-router deny pattern", async () => {
      const ctx = makeContext({
        routerConfig: makeRouterConfig({ cmdDeny: ["/ip/route/remove*"] }),
      });
      await expect(
        runCommandTool.handler({ routerId: "test-router", command: "/ip/route/remove *" }, ctx),
      ).rejects.toBeInstanceOf(MikroMCPError);
    });

    it("throws when command does not match per-router allow list", async () => {
      const ctx = makeContext({
        routerConfig: makeRouterConfig({ cmdAllow: ["/ip/route/print*"] }),
      });
      await expect(
        runCommandTool.handler({ routerId: "test-router", command: "/interface/print" }, ctx),
      ).rejects.toBeInstanceOf(MikroMCPError);
    });
  });
});

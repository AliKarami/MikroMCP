import { describe, it, expect, vi } from "vitest";
import { createChangeManagementTools } from "../../../../src/domain/tools/change-management-tools.js";
import type { ToolDefinition, ToolContext } from "../../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../../src/adapter/rest-client.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as nodeFs from "node:fs";

const ROUTE_RECORD = { ".id": "*1", "dst-address": "10.0.0.0/8", "gateway": "192.168.1.1", "routing-table": "main" };

function makeManageRoute(dryRunResult: string): ToolDefinition {
  return {
    name: "manage_route",
    title: "Manage Route",
    description: "",
    inputSchema: { parse: (p: unknown) => p } as unknown as import("zod").ZodType,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    snapshotPaths: ["ip/route"],
    handler: vi.fn().mockResolvedValue({ content: dryRunResult, structuredContent: { action: "dry_run" } }),
  };
}

function makeContext(records = [ROUTE_RECORD]): ToolContext {
  return {
    routerId: "edge-01",
    correlationId: "corr-1",
    routerConfig: { id: "edge-01" } as unknown as import("../../../../src/types.js").RouterConfig,
    routerClient: { get: vi.fn().mockResolvedValue(records) } as unknown as RouterOSRestClient,
    sshClient: {} as unknown as import("../../../../src/adapter/ssh-client.js").SshClient,
    ftpClient: {} as unknown as import("../../../../src/adapter/ftp-client.js").FtpClient,
    identity: { id: "alice", role: "admin", allowedRouters: [], allowedToolPatterns: [] },
    appConfig: {
      journalPath: "/tmp/test-mikromcp/write-journal.ndjson",
      snapshotDir: "/tmp/test-mikromcp/snapshots",
    } as unknown as import("../../../../src/config/app-config.js").AppConfig,
  };
}

describe("plan_changes", () => {
  it("is registered correctly", () => {
    const tools = createChangeManagementTools([makeManageRoute("dry-run ok")]);
    const tool = tools.find((t) => t.name === "plan_changes");
    expect(tool).toBeDefined();
    expect(tool!.annotations.readOnlyHint).toBe(false);
    expect(tool!.annotations.destructiveHint).toBe(false);
  });

  it("calls each step handler with dryRun=true and returns results", async () => {
    const manageRoute = makeManageRoute("Would add route 10.0.0.0/8");
    const tools = createChangeManagementTools([manageRoute]);
    const planTool = tools.find((t) => t.name === "plan_changes")!;
    const ctx = makeContext();

    const result = await planTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" } }] },
      ctx,
    );

    expect(manageRoute.handler).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, action: "add" }),
      ctx,
    );
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.steps as unknown[]).length).toBe(1);
  });

  it("throws TOOL_NOT_FOUND for unknown tool name", async () => {
    const tools = createChangeManagementTools([]);
    const planTool = tools.find((t) => t.name === "plan_changes")!;
    await expect(
      planTool.handler({ routerId: "edge-01", steps: [{ tool: "nonexistent", params: {} }] }, makeContext()),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("rejects extra fields in input schema", () => {
    const tools = createChangeManagementTools([]);
    const planTool = tools.find((t) => t.name === "plan_changes")!;
    expect(() =>
      planTool.inputSchema.parse({ routerId: "edge-01", steps: [], unknownField: true }),
    ).toThrow();
  });
});

describe("apply_plan", () => {
  it("is registered with destructiveHint=true", () => {
    const tools = createChangeManagementTools([makeManageRoute("applied")]);
    const tool = tools.find((t) => t.name === "apply_plan");
    expect(tool).toBeDefined();
    expect(tool!.annotations.destructiveHint).toBe(true);
  });

  it("calls each step handler in order", async () => {
    const manageRoute = makeManageRoute("created");
    const tools = createChangeManagementTools([manageRoute]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;
    const ctx = makeContext();

    const result = await applyTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" } }] },
      ctx,
    );

    expect(manageRoute.handler).toHaveBeenCalledWith(
      expect.objectContaining({ action: "add", routerId: "edge-01" }),
      ctx,
    );
    expect(result.content).toContain("1/1");
  });

  it("stops on first failure and reports which step failed", async () => {
    const failingTool: ToolDefinition = {
      ...makeManageRoute(""),
      handler: vi.fn().mockRejectedValue(new Error("Router unreachable")),
    };
    const tools = createChangeManagementTools([failingTool]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;

    const result = await applyTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add" } }] },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("step 1");
  });

  it("records a numeric durationMs in the journal outcome line for a successful step", async () => {
    const appendFsSpy = vi.mocked(nodeFs.appendFileSync);
    appendFsSpy.mockClear();

    const manageRoute = makeManageRoute("created");
    const tools = createChangeManagementTools([manageRoute]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;
    const ctx = makeContext();

    await applyTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" } }] },
      ctx,
    );

    // at least one appended line must be the step outcome
    const calls = appendFsSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // The outcome line is the last call; parse all lines and find the success phase
    const allLines = calls.map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
    const outcomeLine = allLines.find((l) => l.phase === "success");

    expect(outcomeLine).toBeDefined();
    expect(typeof outcomeLine!.durationMs).toBe("number");
    expect(outcomeLine!.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("rejects extra fields in input schema", () => {
    const tools = createChangeManagementTools([]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;
    expect(() =>
      applyTool.inputSchema.parse({ routerId: "edge-01", steps: [], extra: true }),
    ).toThrow();
  });

  it("fails fast without invoking the sub-tool handler when the circuit breaker is already open", async () => {
    const { CircuitBreaker } = await import("../../../../src/adapter/circuit-breaker.js");
    const { MikroMCPError, ErrorCategory } = await import("../../../../src/domain/errors/error-types.js");

    const cb = new CircuitBreaker("test-router", { failureThreshold: 1, cooldownMs: 60_000 });

    // Trip the breaker open with one transient failure
    const transient = new MikroMCPError({
      category: ErrorCategory.ROUTER_UNREACHABLE,
      code: "ECONNREFUSED",
      message: "down",
      recoverability: { retryable: true, suggestedAction: "retry" },
    });
    await cb.execute(() => Promise.reject(transient)).catch(() => {});
    // breaker is now open (failureThreshold 1)

    const handlerSpy = vi.fn().mockResolvedValue({ content: "ok", structuredContent: { action: "created" } });
    const spyTool: ToolDefinition = {
      name: "manage_route",
      title: "Manage Route",
      description: "",
      inputSchema: { parse: (p: unknown) => p } as unknown as import("zod").ZodType,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      snapshotPaths: [],
      handler: handlerSpy,
    };

    const tools = createChangeManagementTools([spyTool]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;

    const ctx = makeContext();
    ctx.circuitBreaker = cb;

    const result = await applyTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add" } }] },
      ctx,
    );

    // The sub-tool handler must never have been called — the open breaker rejected the step
    expect(handlerSpy).not.toHaveBeenCalled();

    // apply_plan must report failure
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.status).toBe("failed");
    expect(structured.failedStep).toBe(0);
  });
});

describe("rollback_change", () => {
  const JOURNAL_LINE_ATTEMPT = JSON.stringify({
    id: "j-abc",
    ts: "2026-05-17T10:00:00Z",
    identityId: "alice",
    role: "admin",
    tool: "manage_route",
    routerId: "edge-01",
    params: { action: "add" },
    snapshotIds: ["20260517-snap-1"],
    phase: "attempt",
  });
  const JOURNAL_LINE_SUCCESS = JSON.stringify({
    id: "j-abc",
    ts: "2026-05-17T10:00:01Z",
    phase: "success",
    durationMs: 123,
  });
  const SNAPSHOT_CONTENT = JSON.stringify({
    id: "20260517-snap-1",
    routerId: "edge-01",
    path: "ip/route",
    ts: "2026-05-17T10:00:00Z",
    records: [],
  });

  it("is registered with destructiveHint=true", () => {
    const tools = createChangeManagementTools([]);
    const tool = tools.find((t) => t.name === "rollback_change");
    expect(tool).toBeDefined();
    expect(tool!.annotations.destructiveHint).toBe(true);
  });

  it("dryRun returns restore plan without applying", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(`${JOURNAL_LINE_ATTEMPT}\n${JOURNAL_LINE_SUCCESS}\n`)
      .mockReturnValueOnce(SNAPSHOT_CONTENT);

    const tools = createChangeManagementTools([]);
    const rollbackTool = tools.find((t) => t.name === "rollback_change")!;
    const ctx = makeContext([ROUTE_RECORD]);

    const result = await rollbackTool.handler(
      { routerId: "edge-01", journalId: "j-abc", dryRun: true },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("dry run");
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.action).toBe("dry_run");
  });

  it("throws NOT_FOUND for unknown journalId", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce("");
    const tools = createChangeManagementTools([]);
    const rollbackTool = tools.find((t) => t.name === "rollback_change")!;

    await expect(
      rollbackTool.handler({ routerId: "edge-01", journalId: "missing-id", dryRun: false }, makeContext()),
    ).rejects.toMatchObject({ code: "JOURNAL_ENTRY_NOT_FOUND" });
  });
});

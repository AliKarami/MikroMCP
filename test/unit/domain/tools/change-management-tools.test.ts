import { describe, it, expect, vi } from "vitest";
import { createChangeManagementTools } from "../../../../src/domain/tools/change-management-tools.js";
import type { ToolDefinition, ToolContext } from "../../../../src/domain/tools/tool-definition.js";
import { loggableParams } from "../../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../../src/adapter/rest-client.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("{}"),
}));

import * as nodeFs from "node:fs";
import * as nodeFsp from "node:fs/promises";

const ROUTE_RECORD = {
  ".id": "*1",
  "dst-address": "10.0.0.0/8",
  gateway: "192.168.1.1",
  "routing-table": "main",
};

function makeManageRoute(dryRunResult: string): ToolDefinition {
  return {
    name: "manage_route",
    title: "Manage Route",
    description: "",
    inputSchema: { parse: (p: unknown) => p } as unknown as import("zod").ZodType,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    snapshotPaths: ["ip/route"],
    handler: vi
      .fn()
      .mockResolvedValue({ content: dryRunResult, structuredContent: { action: "dry_run" } }),
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
      {
        routerId: "edge-01",
        steps: [
          {
            tool: "manage_route",
            params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" },
          },
        ],
      },
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
      planTool.handler(
        { routerId: "edge-01", steps: [{ tool: "nonexistent", params: {} }] },
        makeContext(),
      ),
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
      {
        routerId: "edge-01",
        steps: [
          {
            tool: "manage_route",
            params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" },
          },
        ],
      },
      ctx,
    );

    expect(manageRoute.handler).toHaveBeenCalledWith(
      expect.objectContaining({ action: "add", routerId: "edge-01" }),
      expect.objectContaining({ routerId: ctx.routerId, correlationId: ctx.correlationId }),
    );
    expect(result.content).toContain("1/1");
  });

  it("tells each step's tool what was snapshotted before it ran", async () => {
    const manageRoute = makeManageRoute("created");
    const applyTool = createChangeManagementTools([manageRoute]).find(
      (t) => t.name === "apply_plan",
    )!;
    await applyTool.handler(
      { routerId: "edge-01", steps: [{ tool: "manage_route", params: { action: "add" } }] },
      makeContext(),
    );
    // The test context has no device client, so the snapshot fails, and says so.
    const stepContext = vi.mocked(manageRoute.handler).mock.calls[0][1];
    expect(stepContext.snapshots).toEqual({ taken: [], failed: ["ip/route"] });
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
    const appendFileSpy = vi.mocked(nodeFsp.appendFile);
    appendFileSpy.mockClear();

    const manageRoute = makeManageRoute("created");
    const tools = createChangeManagementTools([manageRoute]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;
    const ctx = makeContext();

    await applyTool.handler(
      {
        routerId: "edge-01",
        steps: [
          {
            tool: "manage_route",
            params: { action: "add", dstAddress: "10.0.0.0/8", gateway: "192.168.1.1" },
          },
        ],
      },
      ctx,
    );

    // Wait for fire-and-forget writes to complete
    await vi.waitFor(() => {
      expect(appendFileSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // The outcome line is the last call; parse all lines and find the success phase
    const allLines = appendFileSpy.mock.calls.map(
      (c) => JSON.parse(c[1] as string) as Record<string, unknown>,
    );
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
    const { MikroMCPError, ErrorCategory } =
      await import("../../../../src/domain/errors/error-types.js");

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

    const handlerSpy = vi
      .fn()
      .mockResolvedValue({ content: "ok", structuredContent: { action: "created" } });
    const spyTool: ToolDefinition = {
      name: "manage_route",
      title: "Manage Route",
      description: "",
      inputSchema: { parse: (p: unknown) => p } as unknown as import("zod").ZodType,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

describe("plan steps in the logs", () => {
  function makeRedactingTool(): ToolDefinition {
    return {
      ...makeManageRoute("applied"),
      redactParams: (params) => ({ ...params, config: "<withheld>" }),
    };
  }
  const steps = [{ tool: "manage_route", params: { config: "community: s3cr3t" } }];

  it("logs each step's parameters as that step's tool would", () => {
    const tools = createChangeManagementTools([makeRedactingTool()]);
    for (const name of ["plan_changes", "apply_plan"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(loggableParams(tool, { routerId: "edge-01", steps })).toEqual({
        routerId: "edge-01",
        steps: [{ tool: "manage_route", params: { config: "<withheld>" } }],
      });
    }
  });

  it("journals an applied step through its tool's redaction", async () => {
    const inner = makeRedactingTool();
    const applyTool = createChangeManagementTools([inner]).find((t) => t.name === "apply_plan")!;
    vi.mocked(nodeFsp.appendFile).mockClear();
    await applyTool.handler({ routerId: "edge-01", steps }, makeContext());
    await vi.waitFor(() => expect(vi.mocked(nodeFsp.appendFile)).toHaveBeenCalled());
    const journal = vi.mocked(nodeFsp.appendFile).mock.calls.map((c) => String(c[1]));
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.join("")).not.toContain("s3cr3t");
    expect(inner.handler).toHaveBeenCalledWith(
      expect.objectContaining({ config: "community: s3cr3t" }),
      expect.anything(),
    );
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
    // Journal file read uses node:fs readFileSync (in change-management-tools.ts)
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${JOURNAL_LINE_ATTEMPT}\n${JOURNAL_LINE_SUCCESS}\n`,
    );
    // Snapshot file read uses node:fs/promises readFile (in snapshot-engine.ts)
    (nodeFsp.readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SNAPSHOT_CONTENT);

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
      rollbackTool.handler(
        { routerId: "edge-01", journalId: "missing-id", dryRun: false },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: "JOURNAL_ENTRY_NOT_FOUND" });
  });
});

describe("list_journal", () => {
  const ATTEMPT_A = JSON.stringify({
    id: "j-a",
    ts: "2026-10-22T10:00:00Z",
    identityId: "superadmin-builtin",
    role: "superadmin",
    tool: "manage_vlan",
    routerId: "edge-01",
    params: { action: "add", name: "vlan10" },
    snapshotIds: ["snap-1"],
    phase: "attempt",
  });
  const ATTEMPT_B = JSON.stringify({
    id: "j-b",
    ts: "2026-10-22T11:00:00Z",
    identityId: "superadmin-builtin",
    role: "superadmin",
    tool: "run_command",
    routerId: "edge-02",
    params: { command: "/interface/vlan/print" },
    snapshotIds: [],
    phase: "attempt",
  });
  const SUCCESS_A = JSON.stringify({
    id: "j-a",
    ts: "2026-10-22T10:00:01Z",
    phase: "success",
    durationMs: 42,
  });
  const FAILURE_B = JSON.stringify({
    id: "j-b",
    ts: "2026-10-22T11:00:01Z",
    phase: "failure",
    outcome: "VLAN_NAME_INVALID",
    durationMs: 7,
  });

  function makeTool() {
    const tools = createChangeManagementTools([]);
    const tool = tools.find((t) => t.name === "list_journal");
    expect(tool).toBeDefined();
    return tool!;
  }

  it("is read-only and fleet-scoped", () => {
    const tool = makeTool();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.skipRouterContext).toBe(true);
  });

  it("rejects unknown input fields (strict schema)", async () => {
    await expect(makeTool().handler({ bogus: 1 }, makeContext())).rejects.toThrow();
  });

  it("pairs attempts with outcomes, newest first", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_A}\n${SUCCESS_A}\n${ATTEMPT_B}\n${FAILURE_B}\n`,
    );
    const result = await makeTool().handler({}, makeContext());
    const sc = result.structuredContent as Record<string, unknown>;
    const entries = sc.entries as Array<Record<string, unknown>>;
    expect(sc.total).toBe(2);
    expect(entries[0].journalId).toBe("j-b");
    expect(entries[0].status).toBe("failure");
    expect(entries[0].outcomeCode).toBe("VLAN_NAME_INVALID");
    expect(entries[1].journalId).toBe("j-a");
    expect(entries[1].status).toBe("success");
    expect(entries[1].durationMs).toBe(42);
    expect(entries[1].snapshotIds).toEqual(["snap-1"]);
  });

  it("marks a torn trailing line's attempt as unknown and skips the fragment", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_B}\n{"id":"j-c","ts":"2026-10-22T12:00:00Z","params":{"command":"/ip addr`,
    );
    const result = await makeTool().handler({}, makeContext());
    const sc = result.structuredContent as Record<string, unknown>;
    const entries = sc.entries as Array<Record<string, unknown>>;
    expect(sc.total).toBe(1);
    expect(entries[0].journalId).toBe("j-b");
    expect(entries[0].status).toBe("unknown");
  });

  it("filters by routerId and tool", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_A}\n${SUCCESS_A}\n${ATTEMPT_B}\n${FAILURE_B}\n`,
    );
    const byRouter = await makeTool().handler({ routerId: "edge-02" }, makeContext());
    expect(
      (byRouter.structuredContent as Record<string, unknown>).entries as unknown[],
    ).toHaveLength(1);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_A}\n${SUCCESS_A}\n${ATTEMPT_B}\n${FAILURE_B}\n`,
    );
    const byTool = await makeTool().handler({ tool: "run_command" }, makeContext());
    const entries = (byTool.structuredContent as Record<string, unknown>).entries as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(1);
    expect(entries[0].journalId).toBe("j-b");
  });

  it("respects the limit", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_A}\n${ATTEMPT_B}\n`,
    );
    const result = await makeTool().handler({ limit: 1 }, makeContext());
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.total).toBe(2);
    expect(sc.returned).toBe(1);
  });

  it("returns empty for a journal file that does not exist yet", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await makeTool().handler({}, makeContext());
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.journalEnabled).toBe(true);
    expect(sc.total).toBe(0);
  });

  it("reports a disabled journal when no path is configured", async () => {
    const ctx = {
      ...makeContext(),
      appConfig: { journalPath: undefined },
    } as unknown as ToolContext;
    const result = await makeTool().handler({}, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.journalEnabled).toBe(false);
    expect(sc.entries).toEqual([]);
  });

  it("throws JOURNAL_READ_FAILED for an unreadable journal", async () => {
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    await expect(makeTool().handler({}, makeContext())).rejects.toMatchObject({
      code: "JOURNAL_READ_FAILED",
    });
  });
});

describe("list_journal - identity scope", () => {
  const ATTEMPT_R1 = JSON.stringify({
    id: "j-r1",
    ts: "2026-10-22T10:00:00Z",
    tool: "manage_vlan",
    routerId: "edge-01",
    params: {},
    snapshotIds: ["snap-1"],
    phase: "attempt",
  });
  const ATTEMPT_R2 = JSON.stringify({
    id: "j-r2",
    ts: "2026-10-22T11:00:00Z",
    tool: "manage_vlan",
    routerId: "edge-02",
    params: {},
    snapshotIds: [],
    phase: "attempt",
  });

  it("hides entries for routers outside the identity's allowedRouters", async () => {
    const nodeFs2 = await import("node:fs");
    (nodeFs2.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_R1}\n${ATTEMPT_R2}\n`,
    );
    const tools = createChangeManagementTools([]);
    const tool = tools.find((t) => t.name === "list_journal")!;
    const ctx = {
      ...makeContext(),
      identity: {
        id: "op",
        role: "operator",
        allowedRouters: ["edge-01"],
        allowedToolPatterns: [],
      },
    } as unknown as ToolContext;

    const result = await tool.handler({}, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    const entries = sc.entries as Array<Record<string, unknown>>;
    expect(sc.total).toBe(1);
    expect(entries[0].journalId).toBe("j-r1");
  });

  it("an unrestricted identity (empty allowedRouters) sees all entries", async () => {
    const nodeFs2 = await import("node:fs");
    (nodeFs2.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      `${ATTEMPT_R1}\n${ATTEMPT_R2}\n`,
    );
    const tools = createChangeManagementTools([]);
    const tool = tools.find((t) => t.name === "list_journal")!;
    const result = await tool.handler({}, makeContext());
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.total).toBe(2);
  });
});

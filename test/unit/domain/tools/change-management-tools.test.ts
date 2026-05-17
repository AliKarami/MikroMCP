import { describe, it, expect, vi } from "vitest";
import { createChangeManagementTools } from "../../../../src/domain/tools/change-management-tools.js";
import type { ToolDefinition, ToolContext } from "../../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../../src/adapter/rest-client.js";

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

  it("rejects extra fields in input schema", () => {
    const tools = createChangeManagementTools([]);
    const applyTool = tools.find((t) => t.name === "apply_plan")!;
    expect(() =>
      applyTool.inputSchema.parse({ routerId: "edge-01", steps: [], extra: true }),
    ).toThrow();
  });
});

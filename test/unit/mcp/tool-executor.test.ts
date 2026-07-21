import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeToolCall, type ToolExecutorDeps } from "../../../src/mcp/tool-executor.js";
import type { ToolDefinition } from "../../../src/domain/tools/tool-definition.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

// Stub modules that require real I/O or external state
vi.mock("../../../src/observability/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../src/domain/snapshot/snapshot-engine.js", () => ({ takeSnapshot: vi.fn() }));
vi.mock("../../../src/domain/snapshot/write-journal.js", () => ({
  recordAttempt: vi.fn().mockReturnValue("j1"),
  recordOutcome: vi.fn(),
}));
vi.mock("../../../src/adapter/adapter-factory.js", () => ({
  createSshClient: vi.fn().mockReturnValue({}),
  createFtpClient: vi.fn().mockReturnValue({}),
  createSftpClient: vi.fn().mockReturnValue({}),
}));

function makeReadTool(
  handler: ToolDefinition["handler"],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: "test_read",
    title: "Test Read",
    description: "test",
    inputSchema: { parse: (x: unknown) => x } as unknown as ToolDefinition["inputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ToolExecutorDeps> = {}): ToolExecutorDeps {
  const fakeRouter = {
    id: "r1",
    host: "h",
    port: 80,
    tls: { enabled: false, rejectUnauthorized: false },
    credentials: { source: "env" as const, envPrefix: "ROUTER_R1" },
    tags: [],
    rosVersion: "7.x",
  };
  return {
    registry: {
      getRouter: vi.fn().mockReturnValue(fakeRouter),
      soleRouterId: vi.fn().mockReturnValue(undefined),
      routerIds: vi.fn().mockReturnValue(["r1", "r2"]),
    } as unknown as ToolExecutorDeps["registry"],
    pool: {
      getClient: vi.fn().mockReturnValue({}),
      removeClient: vi.fn(),
    } as unknown as ToolExecutorDeps["pool"],
    circuitBreakers: new Map(),
    config: {
      stdioIdentity: undefined,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
      ssh: { commandTimeoutMs: 1000, maxOutputBytes: 1024 },
    } as unknown as ToolExecutorDeps["config"],
    identityRegistry: {
      getIdentities: () => [],
    } as unknown as ToolExecutorDeps["identityRegistry"],
    ...overrides,
  };
}

describe("executeToolCall", () => {
  beforeEach(() => {
    process.env.ROUTER_R1_USER = "u";
    process.env.ROUTER_R1_PASS = "p";
  });
  afterEach(() => {
    delete process.env.ROUTER_R1_USER;
    delete process.env.ROUTER_R1_PASS;
  });

  it("happy path — read tool returns formatted result", async () => {
    const tool = makeReadTool(async () => ({ content: "ok", structuredContent: { x: 1 } }));
    const deps = makeDeps();

    const result = await executeToolCall(tool, { routerId: "r1" }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("ok");
  });

  it("missing routerId — returns isError with MISSING_ROUTER_ID code", async () => {
    const tool = makeReadTool(async () => ({ content: "never", structuredContent: {} }));
    const deps = makeDeps();

    const result = await executeToolCall(tool, {}, deps);

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { code?: string };
    expect(sc?.code).toBe("MISSING_ROUTER_ID");
  });

  it("omitted routerId — falls back to MIKROMCP_DEFAULT_ROUTER", async () => {
    const handler = vi.fn(async () => ({ content: "ok", structuredContent: {} }));
    const tool = makeReadTool(handler);
    const deps = makeDeps();
    (deps.config as { defaultRouter?: string }).defaultRouter = "r1";

    const result = await executeToolCall(tool, {}, deps);

    expect(result.isError).toBeFalsy();
    expect(deps.registry.getRouter).toHaveBeenCalledWith("r1");
  });

  it("omitted routerId — falls back to the sole configured router", async () => {
    const tool = makeReadTool(async () => ({ content: "ok", structuredContent: {} }));
    const deps = makeDeps();
    (deps.registry.soleRouterId as ReturnType<typeof vi.fn>).mockReturnValue("r1");

    const result = await executeToolCall(tool, {}, deps);

    expect(result.isError).toBeFalsy();
    expect(deps.registry.getRouter).toHaveBeenCalledWith("r1");
  });

  it("error path — handler throws MikroMCPError, response has isError and error code", async () => {
    const tool = makeReadTool(async () => {
      throw new MikroMCPError({
        category: ErrorCategory.NOT_FOUND,
        code: "X_NOT_FOUND",
        message: "thing not found",
        recoverability: { retryable: false, suggestedAction: "check id" },
      });
    });
    const deps = makeDeps();

    const result = await executeToolCall(tool, { routerId: "r1" }, deps);

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { code?: string };
    expect(sc?.code).toBe("X_NOT_FOUND");
  });

  it("circuit breaker reuse — same router creates only one breaker", async () => {
    const tool = makeReadTool(async () => ({ content: "ok", structuredContent: {} }));
    const deps = makeDeps();

    await executeToolCall(tool, { routerId: "r1" }, deps);
    await executeToolCall(tool, { routerId: "r1" }, deps);

    expect(deps.circuitBreakers.size).toBe(1);
  });

  it("evicts the pooled client when a call fails with ROUTER_AUTH_FAILED", async () => {
    const removeClient = vi.fn();
    const deps = makeDeps({
      pool: { getClient: vi.fn().mockReturnValue({}), removeClient } as never,
    });
    const tool = makeReadTool(async () => {
      throw new MikroMCPError({
        category: ErrorCategory.ROUTER_AUTH_FAILED,
        code: "HTTP_401",
        message: "auth failed",
        recoverability: { retryable: false, suggestedAction: "fix creds" },
      });
    });
    await executeToolCall(tool, { routerId: "r1" }, deps);
    expect(removeClient).toHaveBeenCalledWith("r1");
  });

  it("skipRouterContext — registry.getRouter is never called, handler still runs", async () => {
    let handlerRan = false;
    const tool = makeReadTool(
      async () => {
        handlerRan = true;
        return { content: "fleet-ok", structuredContent: {} };
      },
      { skipRouterContext: true },
    );
    const deps = makeDeps();

    const result = await executeToolCall(tool, {}, deps);

    expect(deps.registry.getRouter).not.toHaveBeenCalled();
    expect(handlerRan).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("fleet-ok");
  });

  it("prepends a verify-state hint when a write times out", async () => {
    const tool = makeReadTool(
      async () => {
        throw new MikroMCPError({
          category: ErrorCategory.ROUTER_TIMEOUT,
          code: "TIMEOUT",
          message: "router did not respond",
          recoverability: { retryable: true, suggestedAction: "Retry later." },
        });
      },
      { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    );

    const result = await executeToolCall(tool, { routerId: "r1" }, makeDeps());

    expect(result.isError).toBe(true);
    const rec = (result.structuredContent as { recoverability?: { suggestedAction?: string } })
      .recoverability;
    expect(rec?.suggestedAction).toMatch(/may already have been applied/i);
  });

  it("does NOT add the verify-state hint for a read tool timeout", async () => {
    const tool = makeReadTool(async () => {
      throw new MikroMCPError({
        category: ErrorCategory.ROUTER_TIMEOUT,
        code: "TIMEOUT",
        message: "router did not respond",
        recoverability: { retryable: true, suggestedAction: "Retry later." },
      });
    });

    const result = await executeToolCall(tool, { routerId: "r1" }, makeDeps());
    const rec = (result.structuredContent as { recoverability?: { suggestedAction?: string } })
      .recoverability;
    expect(rec?.suggestedAction).not.toMatch(/may already have been applied/i);
  });

  it("retries a retryable read tool but not one with retryable:false", async () => {
    const retryableErr = () =>
      new MikroMCPError({
        category: ErrorCategory.ROUTER_TIMEOUT,
        code: "TIMEOUT",
        message: "slow",
        recoverability: { retryable: true, suggestedAction: "retry" },
      });

    // Default read tool (retryable undefined) with maxRetries=1 → 2 calls.
    const retried = vi.fn().mockRejectedValue(retryableErr());
    const depsRetry = makeDeps();
    (depsRetry.config as { retry: { maxRetries: number } }).retry.maxRetries = 1;
    await executeToolCall(makeReadTool(retried), { routerId: "r1" }, depsRetry);
    expect(retried).toHaveBeenCalledTimes(2);

    // Same, but retryable:false → exactly 1 call.
    const once = vi.fn().mockRejectedValue(retryableErr());
    const depsNoRetry = makeDeps();
    (depsNoRetry.config as { retry: { maxRetries: number } }).retry.maxRetries = 1;
    await executeToolCall(
      makeReadTool(once, { retryable: false }),
      { routerId: "r1" },
      depsNoRetry,
    );
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("skipRouterContext — touching routerClient raises a typed error, not a TypeError", async () => {
    const tool = makeReadTool(
      async (_params, context) => {
        // A fleet tool that mistakenly reaches for a router-scoped capability.
        await context.routerClient.get("system/resource");
        return { content: "unreachable", structuredContent: {} };
      },
      { skipRouterContext: true },
    );

    const result = await executeToolCall(tool, {}, makeDeps());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not available in a fleet-tool context");
    expect((result.structuredContent as { code?: string }).code).toBe("FLEET_CONTEXT_UNAVAILABLE");
  });
});

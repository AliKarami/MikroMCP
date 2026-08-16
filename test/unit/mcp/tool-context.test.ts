import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouterToolContext } from "../../../src/mcp/tool-context.js";
import { SwosClient } from "../../../src/adapter/swos-client.js";

function makePool(client: unknown) {
  return { getClient: vi.fn().mockReturnValue(client) };
}

function makeRouterConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1", host: "h", port: 80,
    tls: { enabled: false, rejectUnauthorized: false },
    credentials: { source: "env" as const, envPrefix: "ROUTER_R1" },
    tags: [], rosVersion: "7.x",
    ...overrides,
  };
}

function makeArgs(pool: unknown, routerConfig: unknown) {
  return {
    routerConfig: routerConfig as never,
    correlationId: "c1",
    identity: { id: "i", role: "admin", allowedRouters: [], allowedToolPatterns: [] },
    pool: pool as never,
    config: { ssh: { commandTimeoutMs: 1000, maxOutputBytes: 1024 } } as never,
  };
}

describe("buildRouterToolContext", () => {
  beforeEach(() => {
    process.env.ROUTER_R1_USER = "u";
    process.env.ROUTER_R1_PASS = "p";
  });

  afterEach(() => {
    delete process.env.ROUTER_R1_USER;
    delete process.env.ROUTER_R1_PASS;
  });

  it("assembles a context with pooled client and router metadata", () => {
    const fakeClient = {};
    const pool = makePool(fakeClient);
    const ctx = buildRouterToolContext(makeArgs(pool, makeRouterConfig()));
    expect(ctx.routerId).toBe("r1");
    expect(ctx.routerClient).toBe(fakeClient);
    expect(ctx.deviceClient).toBe(fakeClient);
    expect(ctx.connectionPool).toBe(pool);
    expect(ctx.swosClient).toBeUndefined();
  });

  it("injects swosClient for swos devices when the pool returns a SwosClient", () => {
    const swosClient = new SwosClient("h", 80, { username: "u", password: "p" });
    const ctx = buildRouterToolContext(
      makeArgs(
        makePool(swosClient),
        makeRouterConfig({ deviceType: "swos", rosVersion: "swos" }),
      ),
    );
    expect(ctx.swosClient).toBe(swosClient);
    expect(ctx.deviceClient).toBe(swosClient);
  });

  it("throws a typed error when a SwOS context's routerClient is touched", () => {
    // A RouterOS tool can only get here through a gap in platform gating —
    // fail loudly rather than calling REST methods on a SwOS client.
    const swosClient = new SwosClient("h", 80, { username: "u", password: "p" });
    const ctx = buildRouterToolContext(
      makeArgs(
        makePool(swosClient),
        makeRouterConfig({ deviceType: "swos", rosVersion: "swos" }),
      ),
    );
    expect(() => ctx.routerClient.get("ip/address")).toThrow(/no RouterOS REST API/);
  });

  it("leaves swosClient undefined for routeros devices", () => {
    const fakeClient = {};
    const ctx = buildRouterToolContext(makeArgs(makePool(fakeClient), makeRouterConfig()));
    expect(ctx.swosClient).toBeUndefined();
    expect(ctx.routerClient).toBe(fakeClient);
  });
});

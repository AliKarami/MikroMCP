import { describe, it, expect, vi } from "vitest";
import { buildRouterToolContext } from "../../../src/mcp/tool-context.js";

describe("buildRouterToolContext", () => {
  it("assembles a context with pooled client and router metadata", () => {
    process.env.ROUTER_R1_USER = "u";
    process.env.ROUTER_R1_PASS = "p";
    const fakeClient = {};
    const pool = { getClient: vi.fn().mockReturnValue(fakeClient) };
    const routerConfig = {
      id: "r1", host: "h", port: 80,
      tls: { enabled: false, rejectUnauthorized: false },
      credentials: { source: "env" as const, envPrefix: "ROUTER_R1" },
      tags: [], rosVersion: "7.x",
    };
    const ctx = buildRouterToolContext({
      routerConfig: routerConfig as never,
      correlationId: "c1",
      identity: { id: "i", role: "admin", allowedRouters: [], allowedToolPatterns: [] },
      pool: pool as never,
      config: { ssh: { commandTimeoutMs: 1000, maxOutputBytes: 1024 } } as never,
    });
    expect(ctx.routerId).toBe("r1");
    expect(ctx.routerClient).toBe(fakeClient);
    expect(ctx.connectionPool).toBe(pool);
    delete process.env.ROUTER_R1_USER;
    delete process.env.ROUTER_R1_PASS;
  });
});

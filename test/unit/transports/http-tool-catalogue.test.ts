import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectHttp } from "../../../src/mcp/transports/http.js";
import { createServerFactory } from "../../../src/mcp/server.js";
import { loadAppConfig } from "../../../src/config/app-config.js";
import type { IdentityRegistry } from "../../../src/config/identity-registry.js";
import type { Identity } from "../../../src/types.js";

const dashboard: Identity = {
  id: "dashboard",
  role: "readonly",
  allowedRouters: [],
  allowedToolPatterns: ["list_*"],
} as Identity;

/** One JSON-RPC message from a Streamable HTTP response (JSON or a single SSE event). */
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
  return JSON.parse(data) as Record<string, unknown>;
}

describe("HTTP tools/list follows the caller's allowedToolPatterns", () => {
  it("shows a pattern-scoped identity only the tools it may call", async () => {
    const config = {
      ...loadAppConfig(),
      configPath: join(tmpdir(), "mikromcp-none-routers.yaml"),
      identitiesPath: join(tmpdir(), "mikromcp-none-identities.yaml"),
    };
    const registry = {
      getIdentities: vi.fn().mockReturnValue([dashboard]),
      findIdentityByToken: vi.fn().mockResolvedValue(dashboard),
    } as unknown as IdentityRegistry;
    const { makeServer } = createServerFactory(config, registry);
    const server = await connectHttp(
      makeServer,
      { port: 0, bindHost: "127.0.0.1", maxBodyBytes: 1024 * 1024, rateLimitRpm: 0 },
      registry,
    );
    const { port } = server.address() as import("node:net").AddressInfo;
    const headers = {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    try {
      const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      });
      expect(init.status).toBe(200);
      const sessionId = init.headers.get("mcp-session-id") ?? "";
      await init.text();
      const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).then((r) => r.text());

      const list = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      const body = await rpcResult(list);
      const tools = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(tools.length).toBeGreaterThan(10);
      expect(tools.every((n) => n.startsWith("list_"))).toBe(true);
      expect(tools).not.toContain("manage_firewall_rule");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

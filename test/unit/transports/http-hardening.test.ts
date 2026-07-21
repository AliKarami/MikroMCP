import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRateLimiter,
  readBody,
  BodyTooLargeError,
  connectHttp,
} from "../../../src/mcp/transports/http.js";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IdentityRegistry } from "../../../src/config/identity-registry.js";

function makeRequestStream(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

describe("createRateLimiter", () => {
  it("allows requests within the per-minute limit", () => {
    const check = createRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(check("10.0.0.1")).toBe(true);
    }
  });

  it("blocks the request that exceeds the limit", () => {
    const check = createRateLimiter(3);
    check("10.0.0.1");
    check("10.0.0.1");
    check("10.0.0.1");
    expect(check("10.0.0.1")).toBe(false);
  });

  it("tracks different IPs independently", () => {
    const check = createRateLimiter(2);
    check("10.0.0.1");
    check("10.0.0.1");
    expect(check("10.0.0.1")).toBe(false);
    expect(check("10.0.0.2")).toBe(true);
  });

  it("allows all requests when rpm is 0 (disabled)", () => {
    const check = createRateLimiter(0);
    for (let i = 0; i < 1000; i++) {
      expect(check("10.0.0.1")).toBe(true);
    }
  });
});

describe("readBody", () => {
  it("resolves with parsed JSON body", async () => {
    const req = makeRequestStream('{"key":"value"}');
    const result = await readBody(req, 1024 * 1024);
    expect(result).toEqual({ key: "value" });
  });

  it("resolves with undefined when body is empty", async () => {
    const req = makeRequestStream("");
    const result = await readBody(req, 1024 * 1024);
    expect(result).toBeUndefined();
  });

  it("rejects with BodyTooLargeError when body exceeds limit", async () => {
    const req = makeRequestStream("x".repeat(101));
    await expect(readBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects with SyntaxError when body is invalid JSON", async () => {
    const req = makeRequestStream("not-json");
    await expect(readBody(req, 1024 * 1024)).rejects.toThrow(SyntaxError);
  });

  it("decodes a multi-byte character split across chunk boundaries", async () => {
    // JSON string containing U+2026 (…, 3 bytes) split so the character
    // straddles two chunks. A naive per-chunk toString() yields U+FFFD.
    const payload = Buffer.from('{"msg":"a…b"}', "utf-8");
    const cut = payload.indexOf(0xe2) + 1; // mid-character
    const req = Readable.from([
      payload.subarray(0, cut),
      payload.subarray(cut),
    ]) as unknown as IncomingMessage;
    const result = await readBody(req, 1024 * 1024);
    expect(result).toEqual({ msg: "a…b" });
  });
});

describe("createRateLimiter — window eviction", () => {
  afterEach(() => vi.useRealTimers());

  it("exposes a sweep that drops windows older than the rate window", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter(5);
    limiter("1.1.1.1");
    limiter("2.2.2.2");
    expect(limiter.size()).toBe(2);
    vi.advanceTimersByTime(61_000);
    limiter.sweep();
    expect(limiter.size()).toBe(0);
  });
});

function getRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

function getWithHeaders(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

describe("connectHttp — /metrics authentication", () => {
  async function withServer(
    registry: IdentityRegistry,
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = await connectHttp(
      vi.fn(() => ({}) as unknown as McpServer),
      { port: 0, bindHost: "127.0.0.1", maxBodyBytes: 1024 * 1024, rateLimitRpm: 100 },
      registry,
    );
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("serves /metrics unauthenticated when no identities are configured", async () => {
    const registry = {
      getIdentities: vi.fn().mockReturnValue([]),
      findIdentityByToken: vi.fn(),
    } as unknown as IdentityRegistry;
    await withServer(registry, async (port) => {
      const res = await getRequest(port, "/metrics");
      expect(res.status).toBe(200);
    });
  });

  it("requires a token for /metrics when identities are configured (401 + WWW-Authenticate)", async () => {
    const registry = {
      getIdentities: vi.fn().mockReturnValue([{ id: "op", role: "operator", allowedRouters: [], allowedToolPatterns: [] }]),
      findIdentityByToken: vi.fn().mockResolvedValue(null),
    } as unknown as IdentityRegistry;
    await withServer(registry, async (port) => {
      const res = await getWithHeaders(port, "/metrics", {});
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    });
  });

  it("serves /metrics with a valid token when identities are configured", async () => {
    const identity = { id: "op", role: "operator", allowedRouters: [], allowedToolPatterns: [] };
    const registry = {
      getIdentities: vi.fn().mockReturnValue([identity]),
      findIdentityByToken: vi.fn().mockResolvedValue(identity),
    } as unknown as IdentityRegistry;
    await withServer(registry, async (port) => {
      const res = await getWithHeaders(port, "/metrics", { Authorization: "Bearer tok" });
      expect(res.status).toBe(200);
    });
  });
});

describe("connectHttp — /healthz endpoint", () => {
  it("returns 200 {status:'ok'} without Authorization and bypasses the rate limiter", async () => {
    const mockMakeServer = vi.fn(() => ({}) as unknown as McpServer);
    const mockIdentityRegistry = {
      findIdentityByToken: vi.fn(),
      getIdentities: vi.fn().mockReturnValue([]),
    } as unknown as IdentityRegistry;

    // rateLimitRpm: 1 — any second request to a rate-limited path would get 429.
    // /healthz must bypass the limiter, so both requests below must return 200.
    const server = await connectHttp(
      mockMakeServer,
      { port: 0, bindHost: "127.0.0.1", maxBodyBytes: 1024 * 1024, rateLimitRpm: 1 },
      mockIdentityRegistry,
    );
    const { port } = server.address() as import("node:net").AddressInfo;

    try {
      const response1 = await getRequest(port, "/healthz");
      expect(response1.status).toBe(200);
      expect(JSON.parse(response1.body)).toEqual({ status: "ok" });

      // Second request from the same IP — rate limiter is at 1 rpm, but /healthz bypasses it.
      const response2 = await getRequest(port, "/healthz");
      expect(response2.status).toBe(200);
      expect(JSON.parse(response2.body)).toEqual({ status: "ok" });

      // /healthz must not touch the MCP server factory.
      expect(mockMakeServer).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

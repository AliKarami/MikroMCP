import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRateLimiter,
  rateLimitHeaders,
  rateLimitedBody,
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

  describe("status", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports the full budget for a client it has not seen", () => {
      expect(createRateLimiter(5).status("192.0.2.1")).toEqual({
        limit: 5,
        remaining: 5,
        resetMs: 60_000,
      });
    });

    it("counts down as requests arrive and never goes below zero", () => {
      const check = createRateLimiter(2);
      check("192.0.2.1");
      expect(check.status("192.0.2.1").remaining).toBe(1);
      check("192.0.2.1");
      check("192.0.2.1");
      expect(check.status("192.0.2.1").remaining).toBe(0);
    });

    it("reports the time left in the window, not the full minute", () => {
      vi.useFakeTimers();
      const check = createRateLimiter(1);
      check("192.0.2.1");
      vi.advanceTimersByTime(45_000);
      expect(check.status("192.0.2.1").resetMs).toBe(15_000);
      vi.advanceTimersByTime(15_000);
      expect(check("192.0.2.1")).toBe(true);
    });
  });
});

describe("rate limit response", () => {
  it("rateLimitHeaders gives the limit, the budget left and seconds to reset", () => {
    expect(rateLimitHeaders({ limit: 60, remaining: 7, resetMs: 12_300 })).toEqual({
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "7",
      "RateLimit-Reset": "13",
    });
  });

  it("rateLimitedBody names the limit, the real wait and the way out", () => {
    const body = rateLimitedBody({ limit: 60, remaining: 0, resetMs: 12_300 });
    expect(body.limit).toBe(60);
    expect(body.retryAfterSeconds).toBe(13);
    expect(body.error).toContain("60 requests in 60 seconds");
    expect(body.error).toContain("Retry after 13 seconds");
    expect(body.hint).toContain("MIKROMCP_HTTP_RATE_LIMIT_RPM");
    expect(body.hint).toContain("bulk_read");
  });

  it("never asks for a wait of zero seconds", () => {
    expect(rateLimitedBody({ limit: 5, remaining: 0, resetMs: 10 }).retryAfterSeconds).toBe(1);
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
      getIdentities: vi
        .fn()
        .mockReturnValue([
          { id: "op", role: "operator", allowedRouters: [], allowedToolPatterns: [] },
        ]),
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

describe("connectHttp — rate limiting", () => {
  async function withLimit(rpm: number, fn: (port: number) => Promise<void>): Promise<void> {
    const server = await connectHttp(
      vi.fn(() => ({}) as unknown as McpServer),
      { port: 0, bindHost: "127.0.0.1", maxBodyBytes: 1024 * 1024, rateLimitRpm: rpm },
      {
        getIdentities: vi.fn().mockReturnValue([]),
        findIdentityByToken: vi.fn(),
      } as unknown as IdentityRegistry,
    );
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("tells every request its budget, and the 429 how long to wait", async () => {
    await withLimit(2, async (port) => {
      const first = await getWithHeaders(port, "/elsewhere", {});
      expect(first.headers["ratelimit-limit"]).toBe("2");
      expect(first.headers["ratelimit-remaining"]).toBe("1");

      await getWithHeaders(port, "/elsewhere", {});
      const blocked = await getWithHeaders(port, "/elsewhere", {});
      expect(blocked.status).toBe(429);
      expect(blocked.headers["ratelimit-remaining"]).toBe("0");
      const wait = Number(blocked.headers["retry-after"]);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      const body = JSON.parse(blocked.body) as Record<string, unknown>;
      expect(body.limit).toBe(2);
      expect(body.retryAfterSeconds).toBe(wait);
      expect(String(body.hint)).toContain("MIKROMCP_HTTP_RATE_LIMIT_RPM");
    });
  });

  it("sends no rate limit headers when the limit is off", async () => {
    await withLimit(0, async (port) => {
      const res = await getWithHeaders(port, "/elsewhere", {});
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
      expect(res.status).not.toBe(429);
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

describe("connectHttp — Host, Origin and client IP allow lists", () => {
  async function withGuard(
    lists: { allowedHosts?: string[]; allowedOrigins?: string[]; allowedIps?: string[] },
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = await connectHttp(
      vi.fn(() => ({}) as unknown as McpServer),
      { port: 0, bindHost: "127.0.0.1", maxBodyBytes: 1024 * 1024, rateLimitRpm: 0, ...lists },
      {
        getIdentities: vi.fn().mockReturnValue([]),
        findIdentityByToken: vi.fn(),
      } as unknown as IdentityRegistry,
    );
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("refuses a foreign browser Origin with 403 before authentication", async () => {
    await withGuard({}, async (port) => {
      const res = await getWithHeaders(port, "/mcp", { Origin: "https://evil.example" });
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.code).toBe("ORIGIN_NOT_ALLOWED");
      expect(String(body.hint)).toContain("MIKROMCP_HTTP_ALLOWED_ORIGINS");
    });
  });

  it("lets a request without Origin through to authentication", async () => {
    await withGuard({}, async (port) => {
      const res = await getWithHeaders(port, "/mcp", {});
      expect(res.status).toBe(401);
    });
  });

  it("refuses a Host the server does not answer to (DNS rebinding)", async () => {
    await withGuard({}, async (port) => {
      const res = await getWithHeaders(port, "/mcp", { Host: `rebind.example:${port}` });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as Record<string, unknown>).code).toBe("HOST_NOT_ALLOWED");
    });
  });

  it("guards /metrics too, but never /healthz", async () => {
    await withGuard({ allowedIps: ["192.0.2.0/24"] }, async (port) => {
      expect((await getWithHeaders(port, "/metrics", {})).status).toBe(403);
      expect((await getRequest(port, "/healthz")).status).toBe(200);
    });
  });

  it("refuses to start with a malformed MIKROMCP_HTTP_ALLOWED_IPS entry", async () => {
    await expect(withGuard({ allowedIps: ["10.0.0.0/40"] }, async () => {})).rejects.toThrow(
      /MIKROMCP_HTTP_ALLOWED_IPS/,
    );
  });
});

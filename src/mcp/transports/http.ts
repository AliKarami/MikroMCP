import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../../observability/logger.js";
import type { IdentityRegistry } from "../../config/identity-registry.js";
import { authenticateHttp, withIdentity } from "../../middleware/auth.js";
import { MikroMCPError } from "../../domain/errors/error-types.js";
import { renderPrometheus } from "../../observability/metrics.js";

const log = createLogger("transport-http");

/** Idle timeout after which a Streamable HTTP session is closed and evicted. */
const SESSION_TTL_MS = 30 * 60_000;

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  identityId: string;
  lastSeenMs: number;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum allowed size");
  }
}

export interface RateLimiter {
  (ip: string): boolean;
  sweep(): void;
  size(): number;
}

export function createRateLimiter(rpm: number): RateLimiter {
  const WINDOW_MS = 60_000;
  const windows = new Map<string, { count: number; windowStart: number }>();

  const check = (ip: string): boolean => {
    if (rpm === 0) return true;
    const now = Date.now();
    const entry = windows.get(ip);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      windows.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= rpm) {
      return false;
    }
    entry.count++;
    return true;
  };

  const limiter = check as RateLimiter;
  limiter.sweep = () => {
    const now = Date.now();
    for (const [ip, entry] of windows) {
      if (now - entry.windowStart >= WINDOW_MS) {
        windows.delete(ip);
      }
    }
  };
  limiter.size = () => windows.size;
  return limiter;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        fail(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      // Decode once over the concatenated bytes so multi-byte UTF-8 characters
      // split across chunk boundaries are not corrupted into U+FFFD.
      const data = Buffer.concat(chunks).toString("utf-8");
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });

    req.on("error", (err) => fail(err));
  });
}

export interface HttpTransportConfig {
  port: number;
  bindHost: string;
  maxBodyBytes: number;
  rateLimitRpm: number;
}

export async function connectHttp(
  makeServer: () => McpServer,
  config: HttpTransportConfig,
  identityRegistry: IdentityRegistry,
): Promise<Server> {
  const { port, bindHost, maxBodyBytes, rateLimitRpm } = config;
  const checkRateLimit = createRateLimiter(rateLimitRpm);
  const sweepTimer = setInterval(() => checkRateLimit.sweep(), 60_000);
  sweepTimer.unref();

  const streamableSessions = new Map<string, StreamableSession>();
  const sseTransports = new Map<string, SSEServerTransport>();

  const sessionSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of streamableSessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        streamableSessions.delete(id);
        session.transport.close();
        log.info({ sessionId: id }, "Streamable HTTP session expired (idle TTL)");
      }
    }
  }, 60_000);
  sessionSweep.unref();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ip = req.socket.remoteAddress ?? "unknown";

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const { pathname } = url;

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === "/metrics") {
      // Authenticate the scrape endpoint when any identities are configured, so
      // internal metrics are not exposed unauthenticated.
      if (identityRegistry.getIdentities().length > 0) {
        try {
          await authenticateHttp(req, identityRegistry);
        } catch (err) {
          if (err instanceof MikroMCPError) {
            res.writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": "Bearer",
            });
            res.end(JSON.stringify({ error: err.message, code: err.code }));
            return;
          }
          throw err;
        }
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderPrometheus());
      return;
    }

    if (!checkRateLimit(ip)) {
      log.warn({ ip }, "Rate limit exceeded");
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests. Retry after 60 seconds." }));
      return;
    }

    try {
      if (pathname === "/mcp" || pathname === "/sse" || pathname === "/messages") {
        let identity;
        try {
          identity = await authenticateHttp(req, identityRegistry);
        } catch (err) {
          if (err instanceof MikroMCPError) {
            res.writeHead(401, {
              "Content-Type": "application/json",
              "WWW-Authenticate": "Bearer",
            });
            res.end(JSON.stringify({ error: err.message, code: err.code }));
            return;
          }
          throw err;
        }

        const boundIdentity = identity;
        await withIdentity(boundIdentity, async () => {
          await handleMcpRequest(pathname, req, res, url, port, maxBodyBytes, makeServer, streamableSessions, sseTransports, boundIdentity.id);
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found.",
          endpoints: {
            streamableHttp: "POST /mcp or GET /mcp",
            legacySse: "GET /sse then POST /messages?sessionId=<id>",
          },
        }),
      );
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        }
        return;
      }
      log.error({ err }, "HTTP transport error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.on("close", () => {
    clearInterval(sweepTimer);
    clearInterval(sessionSweep);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, bindHost, () => {
      log.info(
        { port, bindHost },
        "HTTP transport listening (POST /mcp for Streamable HTTP, GET /sse for legacy SSE)",
      );
      resolve();
    });
    httpServer.on("error", reject);
  });

  return httpServer;
}

async function handleMcpRequest(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  port: number,
  maxBodyBytes: number,
  makeServer: () => McpServer,
  streamableSessions: Map<string, StreamableSession>,
  sseTransports: Map<string, SSEServerTransport>,
  identityId: string,
): Promise<void> {
  if (pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (session) {
      // Bind a session to the identity that created it — a token cannot drive
      // another identity's session.
      if (session.identityId !== identityId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session belongs to a different identity." }));
        return;
      }
      session.lastSeenMs = Date.now();
    }

    let transport = session?.transport;

    if (!transport) {
      if (sessionId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, { transport: transport!, identityId, lastSeenMs: Date.now() });
          log.info({ sessionId: id, identityId }, "Streamable HTTP session created");
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) {
          streamableSessions.delete(transport!.sessionId);
          log.info({ sessionId: transport!.sessionId }, "Streamable HTTP session closed");
        }
      };
      await makeServer().connect(transport);
    }

    const body = req.method === "POST" ? await readBody(req, maxBodyBytes) : undefined;
    await transport.handleRequest(req, res, body);
    return;
  }

  if (pathname === "/sse" && req.method === "GET") {
    const sseTransport = new SSEServerTransport("/messages", res);
    const sseServer = makeServer();
    await sseServer.connect(sseTransport);
    sseTransports.set(sseTransport.sessionId, sseTransport);
    sseTransport.onclose = () => {
      sseTransports.delete(sseTransport.sessionId);
    };
    log.info({ sessionId: sseTransport.sessionId }, "SSE client connected");
    await sseTransport.start();
    return;
  }

  if (pathname === "/messages" && req.method === "POST") {
    const sid = url.searchParams.get("sessionId") ?? "";
    const sseTransport = sseTransports.get(sid);
    if (!sseTransport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `SSE session not found: ${sid}` }));
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    await sseTransport.handlePostMessage(req, res, body);
    return;
  }
}

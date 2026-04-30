import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("transport-http");

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum allowed size");
  }
}

export function createRateLimiter(rpm: number): (ip: string) => boolean {
  if (rpm === 0) return () => true;

  const WINDOW_MS = 60_000;
  const windows = new Map<string, { count: number; windowStart: number }>();

  return (ip: string): boolean => {
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
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
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
      data += chunk.toString();
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
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
): Promise<void> {
  const { port, bindHost, maxBodyBytes, rateLimitRpm } = config;
  const checkRateLimit = createRateLimiter(rateLimitRpm);

  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ip = req.socket.remoteAddress ?? "unknown";

    if (!checkRateLimit(ip)) {
      log.warn({ ip }, "Rate limit exceeded");
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests. Retry after 60 seconds." }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const { pathname } = url;

    try {
      if (pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        let transport = sessionId ? streamableSessions.get(sessionId) : undefined;

        if (!transport) {
          if (sessionId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
            return;
          }

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              streamableSessions.set(id, transport!);
              log.info({ sessionId: id }, "Streamable HTTP session created");
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
}

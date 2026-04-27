import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("transport-http");

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
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
    req.on("error", reject);
  });
}

export async function connectHttp(makeServer: () => McpServer, port: number): Promise<void> {
  // Streamable HTTP — one transport+server per session, keyed by Mcp-Session-Id.
  // Stateless mode (sessionIdGenerator: undefined) forbids reuse across requests, so we use
  // stateful mode: the SDK generates a session ID on initialize and the client echoes it back
  // on every subsequent request.
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

  // Legacy SSE transport — one server + transport per connection at /sse + /messages
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const { pathname } = url;

    try {
      // Streamable HTTP (MCP Inspector "Streamable HTTP" mode)
      if (pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        let transport = sessionId ? streamableSessions.get(sessionId) : undefined;

        if (!transport) {
          if (sessionId) {
            // Client claims a session we don't know about
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
            return;
          }

          // New session: create a fresh transport+server pair
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

        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

      // Legacy SSE — open the event stream (MCP Inspector "SSE" mode, GET /sse)
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

      // Legacy SSE — receive client messages (POST /messages?sessionId=...)
      if (pathname === "/messages" && req.method === "POST") {
        const sid = url.searchParams.get("sessionId") ?? "";
        const sseTransport = sseTransports.get(sid);
        if (!sseTransport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `SSE session not found: ${sid}` }));
          return;
        }
        const body = await readBody(req);
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
      log.error({ err }, "HTTP transport error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => {
      log.info({ port }, "HTTP transport listening (POST /mcp for Streamable HTTP, GET /sse for legacy SSE)");
      resolve();
    });
    httpServer.on("error", reject);
  });
}

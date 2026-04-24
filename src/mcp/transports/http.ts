// ---------------------------------------------------------------------------
// MikroMCP - HTTP/SSE transport adapter
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("transport-http");

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => {
      if (!data) { resolve(undefined); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export async function connectHttp(server: McpServer, port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp or GET /mcp." }));
      return;
    }

    try {
      let parsedBody: unknown;
      if (req.method === "POST") {
        parsedBody = await readBody(req);
      }
      await transport.handleRequest(req, res, parsedBody);
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
      log.info({ port }, "HTTP transport listening");
      resolve();
    });
    httpServer.on("error", reject);
  });
}

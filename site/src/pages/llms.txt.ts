import type { APIRoute } from "astro";
import { SITE } from "../data/content.ts";

const body = `# ${SITE.name}

> Open source MikroTik MCP server for RouterOS. Connect Claude, ChatGPT, Cursor and Codex to MikroTik RouterOS using the Model Context Protocol. MikroMCP is an open-source Model Context Protocol (MCP) server that exposes RouterOS as ${SITE.toolCount} typed, auditable tools, so AI assistants like Claude, Cursor, and Codex can inspect, diagnose, and safely operate MikroTik routers in natural language instead of improvising CLI commands.

## What it is

- ${SITE.toolCount} typed MCP tools covering router management, network operations, firewall and policy, routing, secure access, diagnostics, fleet operations, and change safety.
- Fleet-aware: routers are declared in routers.yaml with tags; list_routers enumerates them and bulk_execute fans a tool call out across them.
- Safety layer for LLMs: schema validation, idempotent writes, dry-run previews, snapshots, rollback, confirmation tokens, RBAC, audit logging, and per-router circuit breakers.
- Transports: stdio (desktop clients) and Streamable HTTP / SSE (remote clients).
- Requires MikroTik RouterOS 7.x (uses the REST API).
- Current release: v${SITE.version}, MIT licensed.

## Links

- [Website](${SITE.domain})
- [GitHub repository](${SITE.github})
- [Documentation](${SITE.docs})
- [Getting Started](${SITE.docs}/getting-started/)
- [Available Tools](${SITE.docs}/available-tools/)
- [Architecture](${SITE.docs}/architecture/)
- [Security](${SITE.docs}/security/)

## Install

- npm: \`npm install -g mikromcp\` then \`mikromcp init\`
- Binary: download from GitHub releases (Linux/macOS/Windows)
- Docker: \`docker pull ghcr.io/alikarami/mikromcp:latest\`
`;

export const GET: APIRoute = () =>
  new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

import type { APIRoute } from "astro";
import { SITE, features, examples, faqs } from "../data/content.ts";

const featureLines = features.map((f) => `- ${f.title}: ${f.body}`).join("\n");
const exampleLines = examples.map((e) => `- ${e.label}: "${e.prompt}"`).join("\n");
const faqLines = faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");

const body = `# ${SITE.name} — Full Reference for LLMs

> Open source MikroTik MCP server for RouterOS. Connect Claude, ChatGPT, Cursor and Codex to MikroTik RouterOS using the Model Context Protocol. MikroMCP is an open-source Model Context Protocol (MCP) server that exposes RouterOS as ${SITE.toolCount} typed, auditable tools, so AI assistants like Claude, Cursor, and Codex can inspect, diagnose, and safely operate MikroTik routers in natural language instead of improvising CLI commands.

## What MikroMCP is

Raw router CLI access is the wrong abstraction for AI agents. RouterOS is powerful, but asking an LLM to improvise shell commands against production network gear is risky. MikroMCP gives agents a controlled tool surface: strict schemas, idempotent writes, dry-run previews, per-router circuit breakers, retry policies, RBAC, audit logs, snapshots, and rollback-aware change workflows. It turns MikroTik RouterOS into a production-minded MCP control plane for AI infrastructure, DevOps automation, and modern router management.

- Open source, MIT licensed. Current release: v${SITE.version}.
- ${SITE.toolCount} typed tools.
- Requires MikroTik RouterOS 7.x (uses the REST API).
- Transports: stdio (desktop clients like Claude Desktop) and Streamable HTTP / legacy SSE (remote or service-style clients).

## Feature categories

${featureLines}
- MCP compatibility: stdio for desktop clients, Streamable HTTP and legacy SSE for remote or service-style clients.

## Example prompts

${exampleLines}

## FAQ

${faqLines}

## Install

- npm: \`npm install -g mikromcp\` then run \`mikromcp init\` (guided wizard that configures your router and can register MikroMCP with Claude Desktop).
- Binary: download the standalone binary from the GitHub releases page (Linux x64/arm64, macOS x64/arm64, Windows x64), \`chmod +x\`, then run \`./mikromcp-linux-x64 init\`.
- Docker: \`docker pull ghcr.io/alikarami/mikromcp:latest\`.

## Links

- Website: ${SITE.domain}
- GitHub: ${SITE.github}
- Documentation: ${SITE.docs}
- Getting Started: ${SITE.docs}/getting-started/
- Available Tools: ${SITE.docs}/available-tools/
- Architecture: ${SITE.docs}/architecture/
- Security: ${SITE.docs}/security/
`;

export const GET: APIRoute = () =>
  new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

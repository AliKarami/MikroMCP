# Running

## Quick start (npm install)

If you installed MikroMCP via npm, use the `mikromcp` command:

```bash
mikromcp init      # first-time setup wizard
mikromcp doctor    # verify router connectivity and config
mikromcp serve     # start the MCP server (stdio mode)
mikromcp update    # update to the latest version
```

## From source

```bash
git clone https://github.com/AliKarami/MikroMCP.git
cd MikroMCP
npm install
```

### Development (hot-reload)

```bash
npm run dev
```

Uses `tsx watch` — restarts on file changes. Logs are pretty-printed via `pino-pretty`.

### Production

```bash
npm run build
npm start
```

Builds to `dist/main.js` (ESM via tsup), then runs it with Node. Equivalent to `mikromcp serve` from the npm install.

---

## HTTP Transport

```bash
MIKROMCP_TRANSPORT=http \
MIKROMCP_PORT=3000 \
MIKROMCP_CONFIRMATION_SECRET="$(openssl rand -hex 32)" \
MIKROMCP_CONFIG_PATH=config/routers.yaml \
ROUTER_CORE01_USER=mcp-api \
ROUTER_CORE01_PASS=secret \
  mikromcp serve
```

**Endpoints:**

| Path | Method | Auth required | Description |
|---|---|---|---|
| `/mcp` | GET / POST | Yes (Bearer token) | Streamable HTTP MCP transport |
| `/sse` | GET | Yes (Bearer token) | Legacy SSE MCP transport |
| `/messages` | POST | Yes (Bearer token) | Legacy SSE message posting |
| `/healthz` | GET | No | Liveness/readiness probe — returns `200 {"status":"ok"}`. Not rate-limited. Suitable for Kubernetes `livenessProbe` / `readinessProbe` and Docker `HEALTHCHECK`. |
| `/metrics` | GET | No | Prometheus metrics exposition — returns per-tool call counters (`mikromcp_tool_calls_total`). Not rate-limited. Suitable for Prometheus scraping. |

For Docker and systemd deployment, see [Connecting to AI Assistants](Connecting-to-AI-Assistants#using-docker).

---

## Troubleshooting

Add `MIKROMCP_LOG_LEVEL=debug` to any of the commands above for verbose output.

| Symptom | Likely cause |
|---|---|
| `ROUTER_AUTH_FAILED` | Wrong credentials or RouterOS user lacks `api` / `rest-api` policy |
| `ROUTER_UNREACHABLE` | Router IP or port unreachable — check firewall and `/ip service` on the router |
| `CONFIGURATION` error on startup | `MIKROMCP_CONFIG_PATH` is wrong, file missing, or YAML is invalid |
| No tools visible in AI client | Restart the client after updating `mcpServers` config; check server logs for startup errors |
| `ROUTER_BUSY` | Circuit breaker is open after repeated failures — wait 30 s for it to probe and recover |

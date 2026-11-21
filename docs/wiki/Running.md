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
| `/metrics` | GET | Only when identities are configured (Bearer token) | Prometheus metrics exposition — returns per-tool call counters (`mikromcp_tool_calls_total`). Not rate-limited. Suitable for Prometheus scraping. |

**Rate limit.** `/mcp`, `/sse` and `/messages` share a limit of 60 requests per 60 seconds for each client IP address (a fixed window that starts at the client's first request). Change it with `MIKROMCP_HTTP_RATE_LIMIT_RPM`; `0` turns it off. Every HTTP request counts, not only tool calls: the MCP handshake and a client's notifications use up requests too, and a script that makes one tool call per iteration spends one request each time.

Every rate-limited response carries the budget in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window resets). Past the limit the server answers `429` with a `Retry-After` header (the seconds left in the window, not always a full minute) and a JSON body naming the limit and the way out. To stay under the limit without raising it, put many reads into one request: a single query with a filter and `proplist` instead of many small ones, or `bulk_read` to run one read-only tool on many routers in one request. `bulk_read` does not batch different queries on one router.

### Host, Origin and client IP allow lists

Every request except `/healthz` is checked before authentication:

- **Host.** A DNS-rebinding page in a browser can make requests to `localhost` under its own domain name. When the server is bound to a loopback address (the default `127.0.0.1`), only the `Host` names `localhost`, `127.0.0.1` and `[::1]` are answered. When it is bound elsewhere (`0.0.0.0` in Docker, a LAN address), set `MIKROMCP_HTTP_ALLOWED_HOSTS` to the name clients use, such as `mcp.example.com`; without it the Host check is off and the server logs a warning at startup.
- **Origin.** A request that carries an `Origin` header (a browser) must come from an allowed origin: one listed in `MIKROMCP_HTTP_ALLOWED_ORIGINS`, or, when that is unset, one whose host passes the Host check. Requests without `Origin` (CLI clients, Claude Desktop, `mcp-remote`) are not affected.
- **Client IP.** `MIKROMCP_HTTP_ALLOWED_IPS` limits which client addresses may connect (IPs and CIDRs). IPv4-mapped IPv6 addresses are matched as IPv4. Behind a reverse proxy, list the proxy's address and filter clients at the proxy.

A refused request gets `403` with a JSON body: `code` is `HOST_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED` or `CLIENT_IP_NOT_ALLOWED`, and `hint` names the variable to set. `mikromcp doctor` reports the lists and warns when the Host check is off.

```bash
MIKROMCP_TRANSPORT=http \
MIKROMCP_BIND_HOST=0.0.0.0 \
MIKROMCP_HTTP_ALLOWED_HOSTS=mcp.example.com \
MIKROMCP_HTTP_ALLOWED_IPS=10.0.0.0/8 \
  mikromcp serve
```

For Docker and systemd deployment, see [Connecting to AI Assistants](Connecting-to-AI-Assistants#using-docker).

---

## Troubleshooting

Add `MIKROMCP_LOG_LEVEL=debug` to any of the commands above for verbose output.

| Symptom | Likely cause |
|---|---|
| `ROUTER_AUTH_FAILED` | Wrong credentials or RouterOS user lacks `api` / `rest-api` policy; code `SSH_AUTH_FAILED` — the router refused the SSH login (no `ssh` policy, a key in `/user ssh-keys` blocking password login, wrong `sshPrivateKeyPath`); code `SSH_HOST_KEY_MISMATCH` — the router presented a different SSH host key than `sshFingerprint` pins (re-keyed router or an intercepted connection; see [Pinning the SSH host key](Configuration#pinning-the-ssh-host-key)) |
| `ROUTER_UNREACHABLE` | Router IP or port unreachable — check firewall and `/ip service` on the router |
| HTTP `429` `Too many requests` | The client sent more than `MIKROMCP_HTTP_RATE_LIMIT_RPM` requests (default 60) in 60 seconds. Wait the `Retry-After` seconds, send fewer requests, or raise the limit — see the rate limit paragraph above |
| `CONFIGURATION` error on startup | `MIKROMCP_CONFIG_PATH` is wrong, file missing, or YAML is invalid |
| No tools visible in AI client | Restart the client after updating `mcpServers` config; check server logs for startup errors |
| `ROUTER_BUSY` | Circuit breaker is open after repeated failures — wait 30 s for it to probe and recover |

# Configuration

## Router Registry

MikroMCP reads router definitions from a YAML file. The default path is `~/.mikromcp/routers.yaml` (set by `mikromcp init`). Override with `MIKROMCP_CONFIG_PATH`.

```yaml
# config/routers.yaml
routers:
  core-01:
    host: "10.0.0.1"
    port: 443
    tls:
      enabled: true
      rejectUnauthorized: false   # set true when using a valid CA cert or Let's Encrypt
      # fingerprint: "AA:BB:CC:..."  # optional: pin a self-signed cert's SHA-256 fingerprint
    credentials:
      source: "env"
      envPrefix: "ROUTER_CORE01"  # reads ROUTER_CORE01_USER + ROUTER_CORE01_PASS
    tags: ["datacenter", "core"]
    rosVersion: "7.14"

  edge-01:
    host: "192.168.88.1"
    port: 80
    tls:
      enabled: false              # plaintext — lab/local only
    credentials:
      source: "env"
      envPrefix: "ROUTER_EDGE01"
    tags: ["branch", "edge"]
    rosVersion: "7.12"
```

**`rejectUnauthorized: false`** accepts self-signed certificates. Combine with `fingerprint` to pin the exact certificate and prevent MITM attacks.

---

## Credentials

Set environment variables matching each router's `envPrefix`:

```bash
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-password

export ROUTER_EDGE01_USER=mcp-api
export ROUTER_EDGE01_PASS=your-password
```

Credentials are never logged or included in tool responses.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MIKROMCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MIKROMCP_CONFIG_PATH` | `~/.mikromcp/routers.yaml` | Path to router registry YAML |
| `MIKROMCP_LOG_LEVEL` | `info` | Log verbosity: `trace` `debug` `info` `warn` `error` |
| `MIKROMCP_PORT` | `3000` | HTTP listen port (HTTP transport only) |
| `MIKROMCP_BIND_HOST` | `127.0.0.1` | HTTP bind address (HTTP transport only) |
| `MIKROMCP_IDENTITIES_PATH` | `~/.mikromcp/identities.yaml` | Path to identity/token registry (HTTP transport) |
| `MIKROMCP_STDIO_IDENTITY` | — | Named identity for stdio transport; omit for built-in superadmin |
| `MIKROMCP_CONFIRMATION_SECRET` | — | HMAC secret for confirmation tokens — **required in HTTP mode** |
| `MIKROMCP_AUDIT_LOG_PATH` | — | Path for NDJSON audit log file; omit to disable file sink |
| `MIKROMCP_SNAPSHOT_RETENTION_DAYS` | `30` | Age in days after which config snapshots are pruned at startup |
| `MIKROMCP_CMD_ALLOW` | — | Global command allowlist for `run_command` (comma-separated patterns) |
| `MIKROMCP_CMD_DENY` | — | Global command denylist for `run_command` (comma-separated patterns) |
| `ROUTER_<PREFIX>_USER` | — | Router username (matches `envPrefix` in YAML) |
| `ROUTER_<PREFIX>_PASS` | — | Router password (matches `envPrefix` in YAML) |

---

## Identities (HTTP transport)

When running in HTTP mode, clients authenticate with a bearer token. Tokens are bcrypt hashes stored in `config/identities.yaml`:

```yaml
# config/identities.yaml
identities:
  - name: claude-desktop
    tokenHash: "$2b$10$..."   # bcrypt hash of the bearer token
    allowedRouters: ["core-01", "edge-01"]
    allowedToolPatterns: ["list_*", "get_*", "ping", "traceroute"]

  - name: automation
    tokenHash: "$2b$10$..."
    allowedRouters: ["*"]
    allowedToolPatterns: ["*"]
```

Generate a token hash:

```bash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your-token', 10).then(console.log)"
```

Pass the raw token in API requests:

```
Authorization: Bearer your-token
```

---

## HTTP Transport

Set `MIKROMCP_TRANSPORT=http` to run MikroMCP as a long-lived HTTP service instead of a stdio subprocess. Required for Docker, systemd, and multi-client setups.

```bash
export MIKROMCP_TRANSPORT=http
export MIKROMCP_PORT=3000
export MIKROMCP_BIND_HOST=127.0.0.1
export MIKROMCP_CONFIRMATION_SECRET="$(openssl rand -hex 32)"
export MIKROMCP_CONFIG_PATH=/etc/mikromcp/routers.yaml
export ROUTER_CORE01_USER=mcp-api
export ROUTER_CORE01_PASS=your-password
mikromcp serve
```

MikroMCP listens at:
- `POST /mcp` — JSON-RPC tool calls
- `GET /mcp` — SSE event stream for clients that support streaming

Every request must carry `Authorization: Bearer <token>`.

For Docker and systemd deployment examples, see [Connecting to AI Assistants](Connecting-to-AI-Assistants#using-docker).

---

## Per-Router SSH and FTP

The SSH adapter (`ping`, `traceroute`, `torch`, `run_command`) and FTP adapter (`upload_file`) use the same credentials as the REST API. They do not need separate configuration — ensure the RouterOS user has the required policies (`ssh`, `sniff`, `ftp`) as described in [RouterOS API Setup](RouterOS-API-Setup#required-policies-by-tool-category).

Per-router command allow/deny overrides:

```yaml
routers:
  core-01:
    cmdAllow: ["/ip route print*", "/ip address print*"]
    cmdDeny: ["/system reset*"]
```

Per-router overrides take precedence over `MIKROMCP_CMD_ALLOW` / `MIKROMCP_CMD_DENY` env vars.

# MikroMCP Security Guide

This document covers the threat model, deployment recommendations, and responsible disclosure process for MikroMCP.

---

## Threat model

### MCP client trust

MikroMCP trusts the MCP client completely. The server has no way to verify that tool calls were initiated by a human, that the client has not been compromised, or that the prompts driving tool calls are not adversarial. Mitigation:

- Run only trusted, vetted MCP clients against a production MikroMCP instance.
- In HTTP mode, bearer tokens establish *identity* but do not provide *isolation* — a compromised token allows full use of that identity's permissions.
- Use RBAC (see below) to limit what any single identity can do.

### Credential exposure

RouterOS credentials are read from environment variables (`ROUTER_<PREFIX>_USER`, `ROUTER_<PREFIX>_PASS`) or a `.env` file. They are never stored in `config/routers.yaml`.

- **Never commit `.env` to version control.** Add it to `.gitignore`.
- **Never log credentials.** MikroMCP never logs auth headers or passwords, but custom log processors or reverse proxies may. Audit your log pipeline.
- Rotate RouterOS API credentials independently from MikroMCP tokens. Use RouterOS user groups to limit API credentials to the minimum required policies (see policy table below).
- On Linux, use a secrets manager (e.g., systemd credentials, Vault, AWS Secrets Manager) rather than a plain `.env` file for production deployments.

### HTTP transport attack surface

When `MIKROMCP_TRANSPORT=http`:

- By default the server binds to `127.0.0.1`. Never expose the raw port to an untrusted network.
- All endpoints require a valid bearer token (`Authorization: Bearer <token>`). Requests without a valid token are rejected with HTTP 401.
- The server enforces a body size limit to prevent request-body amplification attacks.
- Rate limiting is applied per token identity to reduce brute-force and runaway-agent risk.
- **Always put MikroMCP behind a reverse proxy (nginx, Caddy, Traefik) with TLS** when exposing it beyond localhost. The server itself does not terminate TLS.
- Set `MIKROMCP_CONFIRMATION_SECRET` to a strong random secret in HTTP mode. Without it the server will not start in HTTP mode. This secret signs confirmation tokens and must be kept confidential.

### Destructive tool risk

Tools that modify or delete router state use a two-step confirmation flow:

1. The first call returns a short-lived confirmation token (HMAC-SHA256, 5-minute TTL, single-use).
2. The caller must echo the token back in a second call to execute the change.

This prevents accidental fan-out: a runaway agent loop or a misrouted tool call cannot cause destructive changes without a human-in-the-loop confirmation step (or an automation that explicitly handles the confirmation round-trip).

`bulk_execute` explicitly blocks destructive tools — it only permits read-only and idempotent write operations to prevent unintended mass changes across a router fleet.

---

## Least-privilege RouterOS policy table

Create a dedicated RouterOS API user for MikroMCP and grant only the policies required by the tools you actually use. Do not use the `full` group unless `manage_user` is required.

| Tool category | Required RouterOS policies |
|---|---|
| All `list_*` and `get_*` read tools | `read`, `rest-api` |
| Write tools — firewall, routes, IP, DNS, bridges, WireGuard, WiFi, scheduler, scripts, containers | `read`, `write`, `rest-api` |
| `ping`, `traceroute`, `torch` | `read`, `test`, `rest-api` |
| `run_command` (SSH path) | `read`, `write`, `test`, `ssh` |
| `upload_file` | `read`, `write`, `ftp` |
| `reboot` | `read`, `write`, `reboot`, `rest-api` |
| `manage_certificate` | `read`, `write`, `rest-api` |
| `manage_user` | `read`, `write`, `rest-api` (user must be in `full` group) |

RouterOS policy reference: [MikroTik manual — User groups](https://help.mikrotik.com/docs/display/ROS/User)

---

## Recommended deployment

### Bind address

Always bind to localhost unless you are running MikroMCP as a network service behind a reverse proxy:

```bash
MIKROMCP_BIND_HOST=127.0.0.1  # default; explicitly set for clarity
```

### Confirmation secret

Set a strong random secret for confirmation token signing in HTTP mode:

```bash
MIKROMCP_CONFIRMATION_SECRET=$(openssl rand -hex 32)
```

Store this in your secrets manager, not in a file committed to source control. The server refuses to start in HTTP mode without this variable set.

### TLS and certificate pinning

If your RouterOS device uses a self-signed certificate, configure TLS fingerprint pinning in `config/routers.yaml` rather than disabling certificate verification:

```yaml
routers:
  - id: core-router
    host: 192.168.88.1
    tls:
      rejectUnauthorized: true      # keep true
      fingerprint: "AA:BB:CC:..."   # SHA-256 fingerprint of the router cert
```

Only set `rejectUnauthorized: false` in isolated lab environments. Never disable certificate verification on production routers — it exposes credentials to man-in-the-middle attacks.

### RBAC roles

Assign the minimum role needed for each identity:

| Role | Capabilities |
|---|---|
| `readonly` | All `list_*` and `get_*` tools only |
| `operator` | Read tools + diagnostic tools (`ping`, `traceroute`, `torch`, `get_log`) |
| `admin` | All tools except identity/token management |
| `superadmin` | Full access including identity management |

Recommended assignments:
- **Interactive Claude Desktop / Cursor users:** `operator` role. They can read and diagnose but cannot modify production config without an explicit escalation.
- **Automated CI/CD pipelines:** `admin` role scoped to specific routers via the router allowlist in the identity config.
- **Human operators managing identities:** `superadmin` — keep this to a minimum, prefer two-person rule for superadmin operations.

### Token rotation

Bearer tokens should be rotated on a schedule or on any suspected compromise:

1. Issue a new token with `mikromcp identity add-token <identity>`.
2. Update the client configuration.
3. Revoke the old token with `mikromcp identity revoke-token <identity> <token-id>`.

Run `mikromcp doctor` after rotation to verify all tokens are reachable and correctly hashed.

### Audit logging

Enable the file audit log sink in production to maintain a record of every tool call and its outcome:

```bash
MIKROMCP_AUDIT_LOG_PATH=/var/log/mikromcp/audit.ndjson
```

The audit log is NDJSON. Each line includes the correlation ID, identity, tool name, router ID, input parameters (credentials redacted), and outcome. Feed it to your SIEM or log aggregator for alerting on destructive operations.

---

## Responsible disclosure

If you discover a security vulnerability in MikroMCP, please report it privately before public disclosure:

**Contact:** ali.karami.m@gmail.com

**Please include:**
- A clear description of the vulnerability and its potential impact
- Step-by-step reproduction instructions
- The MikroMCP version and transport mode affected
- Any relevant log output or proof-of-concept code

**Disclosure timeline:**
- You will receive an acknowledgment within 72 hours.
- A fix will be targeted within **90 days** of the initial report.
- You are asked not to disclose the issue publicly until a fix is available or the 90-day window has elapsed, whichever comes first.
- Credit will be given in the release notes unless you prefer to remain anonymous.

Issues that do not require a coordinated fix (e.g., documentation improvements, non-exploitable hardening suggestions) can be filed as public GitHub issues.

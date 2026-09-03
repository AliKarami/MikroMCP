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
    sshUsername: "automation"      # optional; defaults to the REST username
    sshPrivateKeyPath: "/home/mikromcp/.ssh/id_ed25519"
    sshFingerprint: "aabbcc..."    # optional raw SHA-256 host-key fingerprint (hex)

  edge-01:
    host: "192.168.88.1"
    port: 80
    tls:
      enabled: false              # plaintext — lab/local only
      rejectUnauthorized: true
    credentials:
      source: "env"
      envPrefix: "ROUTER_EDGE01"
    tags: ["branch", "edge"]
    rosVersion: "7.12"
```

**`rejectUnauthorized: false`** accepts self-signed certificates. Combine with `fingerprint` to pin the exact certificate and prevent MITM attacks.

`tls` and `rosVersion` are **required** for RouterOS devices. They are deliberately not optional: a missing `tls` block would silently downgrade the router to plaintext HTTP and send credentials in the clear, and a missing `rosVersion` would make MikroMCP guess REST paths that differ between releases.

---

## SwOS switches

> **Experimental.** MikroTik does not document the `.b` API; MikroMCP's schema was reverse-engineered from a **CSS610-8P-2S+ on SwOS Lite 2.21** (the device's own `engine.js` plus live captures). Reads degrade gracefully on other models — unrecognised keys simply surface under `_raw`. Writes are model- and firmware-specific: preview with `dryRun` and keep the `rollback_change` journal ID before applying one to hardware this has not been tested on.

MikroTik switches running **SwOS** or **SwOS Lite** (CSS326, CSS610 and friends) have no RouterOS REST API. They expose a `.b` HTTP API with digest auth instead. Declare them with `deviceType: "swos"`:

```yaml
routers:
  switch-01:
    host: "10.0.0.2"
    port: 80                      # SwOS serves plain HTTP on port 80
    deviceType: "swos"            # "swos-lite" is accepted as an alias
    credentials:
      source: "env"
      envPrefix: "SWITCH_CORE01"  # reads SWITCH_CORE01_USER + SWITCH_CORE01_PASS
    tags: ["access", "layer2"]
```

- One device type covers both firmware editions: SwOS and SwOS Lite speak the same API and differ only in how they name fields, which is detected per field from the device's own response. `deviceType: "swos-lite"` is accepted and normalised to `swos`.
- `tls` and `rosVersion` are omitted — the firmware speaks plain HTTP only, and setting `tls.enabled: true` is rejected at config load.
- Only the `swos_*` tools (plus `check_router_health`, `list_routers` and `rollback_change`) run against these devices. Any RouterOS tool aimed at a switch fails with `PLATFORM_MISMATCH`, and vice versa — including `plan_changes` and `apply_plan`, which are RouterOS-only. Preview a SwOS write with `write_swos_blob`'s `dryRun` (its default) instead.
- Credentials are never sent in the clear — digest auth hashes them — but the payload itself is unencrypted, and the digest is MD5. Keep switch management on a trusted VLAN.
- Writes are whole-blob: the endpoint is read, the requested fields are merged in, and everything else is re-sent byte-for-byte. Fields the device did not send are refused rather than injected, so a firmware that renames or drops a key fails loudly instead of writing junk.
- Every write and preview reports a **firmware compatibility** verdict — see below.

### Firmware compatibility

Because the API is undocumented, a firmware update can change it. MikroMCP handles the three kinds of drift differently:

| Drift | Behaviour |
|---|---|
| Field **removed or renamed** | The write is **refused** (`SWOS_UNKNOWN_FIELD`) — the key is not in the blob the device sent, so it cannot be written. |
| Field **added** | Preserved byte-for-byte across writes, listed under `_raw` on reads, and named in the write result as an unmapped key. |
| Field **meaning changed** under the same key | Cannot be detected structurally. This is what the version check is for. |

`get_swos_status` and `write_swos_blob` compare the switch's model and firmware against the set the schema was validated on, and report the verdict in `structuredContent.compatibility`:

```
⚠️  Firmware: CSS610-8P-2S+ runs 2.24; the schema was verified on 2.21.
    Field meanings may have changed — review the diff before applying.
```

This **warns, it does not block**: an allow-list of firmware versions cannot be kept current for hardware the project has never seen, and refusing everything unverified would make the feature useless on exactly the devices that need it. Treat an unverified verdict as a reason to read the dry-run diff rather than skim it. If a capture from another model or firmware has been diffed against the schema, add it to `VERIFIED_FIRMWARE` in `src/adapter/swos-protocol.ts`.

See [Available Tools](Available-Tools) for the SwOS tool reference.

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
| `MIKROMCP_DEFAULT_ROUTER` | — | Router id used when a tool call omits `routerId`; falls back to the sole configured router when only one exists |
| `MIKROMCP_DATA_DIR` | `~/.mikromcp/data` | Base directory for snapshots and the write journal |
| `MIKROMCP_LOG_LEVEL` | `info` | Log verbosity: `trace` `debug` `info` `warn` `error` |
| `MIKROMCP_PORT` | `3000` | HTTP listen port (HTTP transport only) |
| `MIKROMCP_BIND_HOST` | `127.0.0.1` | HTTP bind address (HTTP transport only) |
| `MIKROMCP_HTTP_MAX_BODY_BYTES` | `1048576` (1 MB) | Maximum request body size for HTTP transport |
| `MIKROMCP_HTTP_RATE_LIMIT_RPM` | `60` | Request rate limit in requests per minute (HTTP transport) |
| `MIKROMCP_IDENTITIES_PATH` | `~/.mikromcp/identities.yaml` | Path to identity/token registry (HTTP transport) |
| `MIKROMCP_STDIO_IDENTITY` | — | Named identity for stdio transport; omit for built-in superadmin |
| `MIKROMCP_CONFIRMATION_SECRET` | — | HMAC secret for confirmation tokens — **required in HTTP mode** |
| `MIKROMCP_AUDIT_LOG_PATH` | — | Path for NDJSON audit log file; omit to disable file sink |
| `MIKROMCP_SNAPSHOT_RETENTION_DAYS` | `30` | Age in days after which config snapshots are pruned at startup |
| `MIKROMCP_SSH_COMMAND_TIMEOUT_MS` | `30000` | Timeout in milliseconds for SSH commands (`run_command`, `torch`, etc.) |
| `MIKROMCP_SSH_MAX_OUTPUT_BYTES` | `524288` (512 KB) | Maximum output size captured from SSH commands |
| `MIKROMCP_CMD_ALLOW` | — | Global command allowlist for `run_command` (comma-separated patterns) |
| `MIKROMCP_CMD_DENY` | — | Global command denylist for `run_command` (comma-separated patterns) |
| `ROUTER_<PREFIX>_USER` | — | Router username (matches `envPrefix` in YAML) |
| `ROUTER_<PREFIX>_PASS` | — | Router password (matches `envPrefix` in YAML) |

### Default router resolution

When a tool call omits `routerId`, MikroMCP resolves the target router in two steps: first it checks `MIKROMCP_DEFAULT_ROUTER`; if that is unset it falls back to the sole configured router (when exactly one is defined in `routers.yaml`). If neither condition is met (multiple routers, no default set) the call is rejected with a `VALIDATION` error (`MISSING_ROUTER_ID`) that lists the available routers. `mikromcp init` writes `MIKROMCP_DEFAULT_ROUTER` into `~/.mikromcp/.env` automatically, so single-router setups work without specifying `routerId` in every prompt.

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

## Per-Router SSH, SFTP, and FTP

By default, the SSH adapter (`ping`, `traceroute`, `torch`, `run_command`) and
the SFTP path used by `upload_file` use the same username and password as the
REST API. A router can instead use a separate SSH/SFTP username and private
key:

```yaml
sshUsername: "automation"
sshPrivateKeyPath: "/home/mikromcp/.ssh/id_ed25519"
```

`sshPrivateKeyPath` must be absolute. When it is configured, MikroMCP sends the
private key to the SSH and SFTP clients and does not send the REST password to
either client. The file stays local: the registry stores only its path, and
`list_routers` does not return the path or key contents. Protect the file with
owner-only permissions such as `0600`. Encrypted private keys are not supported
by these fields.

If SFTP is unavailable, `upload_file` can fall back to plaintext FTP using the
REST credentials. Ensure the relevant RouterOS users have the required policies
(`ssh`, `sniff`, `ftp`) described in
[RouterOS API Setup](RouterOS-API-Setup#required-policies-by-tool-category).

Per-router command allow/deny overrides:

```yaml
routers:
  core-01:
    cmdAllow: ["/ip route print*", "/ip address print*"]
    cmdDeny: ["/system reset*"]
```

Per-router overrides take precedence over `MIKROMCP_CMD_ALLOW` / `MIKROMCP_CMD_DENY` env vars.

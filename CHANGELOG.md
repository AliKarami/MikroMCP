# Changelog

All notable changes to MikroMCP are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

Each release section covers changes **since the previous release only**.

---

## [Unreleased]

---

## [1.2.0] - 2026-05-23

### Added
- `manage_vlan` — add, remove, enable, or disable VLAN interfaces (idempotent by name; supersedes `create_vlan`)
- `list_ip_pools`, `manage_ip_pool` — IP address pool tools (renamed from `list_dhcp_pools`/`manage_dhcp_pool`; pools serve any subsystem, not only DHCP)
- `manage_dhcp_lease` — convert dynamic DHCP leases to static or remove leases (idempotent by MAC address; make-static is a no-op when lease is already static)
- `list_dhcp_clients`, `manage_dhcp_client` — DHCP client configuration per interface (which interfaces obtain IP via DHCP)
- `list_ip_services`, `manage_ip_service` — view and enable/disable RouterOS IP services (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp; port changes excluded to prevent lockout)

### Changed
- `list_dhcp_leases` gains `leaseType` filter (`dynamic`, `static`, `all`) to distinguish lease types
- `list_dhcp_servers` gains `offset` parameter for consistent pagination across all list tools

### Removed
- `create_vlan` — replaced by `manage_vlan` which covers the full interface lifecycle
- `list_dhcp_pools`, `manage_dhcp_pool` — renamed to `list_ip_pools`, `manage_ip_pool`

---

## [1.1.0] - 2026-05-22

### Added
- `GET /healthz` endpoint on the HTTP transport for container liveness/readiness probes (unauthenticated, not rate-limited).
- `GET /metrics` Prometheus endpoint exposing per-tool call counters (`mikromcp_tool_calls_total`).
- `bulk_execute` can now fan out destructive tools when given a fleet confirmation token (two-step HMAC flow; requires `MIKROMCP_CONFIRMATION_SECRET`).
- `MIKROMCP_SNAPSHOT_RETENTION_DAYS` (default 30) — config snapshots older than this are pruned at server startup.
- Expanded snapshot semantic keys so `rollback_change` produces in-place updates (instead of delete-then-create) for certificates, files, VRRP, DHCP servers, IPSec peers, IP pools, simple queues, netwatch entries, and users.

### Changed
- Server version is derived from `package.json` (generated `src/version.ts`) instead of a hardcoded string.
- Snapshot, write-journal, and audit-log file writes are now asynchronous (non-blocking).

### Fixed
- Read tools now retry on transient HTTP 5xx / timeout / busy responses (the retry engine previously honoured only raw network errors).
- Circuit breaker half-open state now admits a single recovery probe at a time.
- `apply_plan` records real per-step duration in the write journal, and its sub-steps now run through the per-router circuit breaker so a plan fails fast against a router known to be down.
- Audit log and write journal now redact VPN/crypto secrets (WireGuard private keys, IPSec PSK, SNMP community strings).
- `MIKROMCP_AUDIT_LOG_PATH` set via `~/.mikromcp/.env` now activates the audit file sink (it was read before dotenv loaded and silently ignored).
- HTTP rate-limiter no longer leaks memory — stale per-IP windows are swept periodically.
- The pooled RouterOS REST client is now evicted after a router authentication failure.
- `bulk_execute` fleet operations are now written to the audit log (previously produced no audit trail).
- `mikromcp init` now writes empty `allowedRouters`/`allowedToolPatterns` (the documented "all" sentinel) instead of `["*"]`, which silently denied access to every router.

### Removed
- Unused `pagination` configuration block.

---

## [1.0.10] - 2026-05-20

### Fixed
- MCP Registry name casing corrected to `io.github.AliKarami/mikromcp` (was lowercase, causing 403 on publish).
- MCP Registry description trimmed to satisfy 100-character validation limit.

---

## [1.0.9] - 2026-05-20

### Added
- MCP Registry metadata and GitHub Actions publishing via `mcp-publisher` OIDC.

### Changed
- Add npm `mcpName` ownership marker for `io.github.alikarami/mikromcp`.

---

## [1.0.8] - 2026-05-20

### Fixed
- Suppress dotenv v17 stdout output in stdio transport (dotenv 17 writes to stdout on load, which corrupted the JSON-RPC stream)

---

## [1.0.7] - 2026-05-20

### Fixed
- `mikromcp init`: default router port to 80, set `rejectUnauthorized: false`, quote YAML string values to prevent parse errors

---

## [1.0.6] - 2026-05-20

### Fixed
- `mikromcp init`: overwrite `.env` instead of appending when re-running; warn upfront if config files already exist

---

## [1.0.5] - 2026-05-20

### Added
- `mikromcp update` CLI command — self-updates the installed package via npm

---

## [1.0.4] - 2026-05-20

### Fixed
- `mikromcp init`: add transport selection prompt; collect and write router credentials to `.env`

### Changed
- README quick-start rewritten for the `npm install / init / doctor` workflow

---

## [1.0.3] - 2026-05-20

### Fixed
- Default all config paths to `~/.mikromcp/` for consistent behaviour across install methods

---

## [1.0.2] - 2026-05-20

### Fixed
- Remove unused `platform` import and stray `data` parameter; add `lint` + `typecheck` to `npm test`

---

## [1.0.1] - 2026-05-20

### Fixed
- Bundle all dependencies for pkg binary and stub `node:sqlite`; use separate tsup config for pkg binaries to avoid native-addon conflicts
- Normalize `repository.url` to `git+https` format for npm provenance

---

## [1.0.0] - 2026-05-20

Initial stable release.

### Added
- 60+ RouterOS management tools across: system, interfaces, IP, DHCP, DNS, routing, firewall, IPSec, WireGuard, WiFi, VLANs, certificates, users, files, containers, queues, scripts, scheduler, and diagnostics
- stdio and HTTP/SSE transports
- Per-router circuit breaker and retry engine
- Role-based access control via `config/identities.yaml`
- HMAC confirmation tokens for destructive operations
- NDJSON audit log
- `mikromcp init` and `mikromcp doctor` CLI commands
- Docker image and pre-built binaries via CI release pipeline

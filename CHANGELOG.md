# Changelog

All notable changes to MikroMCP are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

Each release section covers changes **since the previous release only**.

---

## [Unreleased]

### Added
- `MIKROMCP_DEFAULT_ROUTER` environment variable — sets the router used when a tool call omits `routerId`
- MikroMCP usage skill (`skills/mikromcp/`) — a progressive-disclosure Claude Code skill for driving the tools safely (tool selection, dry-run/confirm/rollback flows, fleet ops, error recovery) with curated links to official MikroTik documentation. See `docs/wiki/Using-the-Skill.md`.

### Changed
- `routerId` is now optional on every router-scoped tool. When omitted, the server resolves it from `MIKROMCP_DEFAULT_ROUTER`, or the sole configured router when exactly one exists; otherwise it returns a `MISSING_ROUTER_ID` error listing available routers
- Slimmed the advertised tool catalog (`tools/list`) by reusing shared schema-field definitions and tightening the longest tool descriptions — roughly 14% fewer tokens per catalog with no change to tool behaviour
- List tools now return a concise summary in their text `content`; full per-item detail remains in `structuredContent`, avoiding duplicate payloads across both result fields
- `mikromcp init` now writes `MIKROMCP_DEFAULT_ROUTER` (set to the configured router) into `.env` and points to the usage skill in its next-steps
- `mikromcp doctor` now validates default-router resolution (errors if `MIKROMCP_DEFAULT_ROUTER` names an unknown router, notes the implicit sole-router default, warns when multiple routers have no default) and checks whether the usage skill is installed
- Internal: extracted a shared `paginate()` helper for client-side pagination, a shared `toolError()` handler-error wrapper, and made the circuit breaker `state` getter side-effect-free (the open→half-open transition is now explicit). No user-facing behaviour change.

### Fixed
- Audit log redaction now recurses into arrays, so secrets nested in step arrays (e.g. `apply_plan` / `bulk_execute` step params) are stripped instead of leaking
- `manage_firewall_rule` idempotency now compares `src-address`, `dst-address`, and `protocol` in addition to chain/action/ports — previously rules differing only by address or protocol were treated as identical (returned `already_exists`) instead of raising a `CONFLICT`
- `bulk_execute` now takes config snapshots and writes journal entries for destructive sub-operations, matching single-router write tools (enables rollback of fleet changes)

---

## [1.5.0] - 2026-05-28

### Added
- `manage_dns_settings` tool — write upstream servers, cache TTL, allow-remote-requests
- `delete_file` tool — delete a file from the router filesystem by name
- `manage_ipsec_policy` tool — add/remove/enable/disable IPSec policies
- `manage_wireguard_interface` tool — add/remove/enable/disable WireGuard interfaces
- `get_container_config` tool — read global container registry/RAM/veth config
- `manage_container_config` tool — write global container config settings
- `list_container_envs` tool — list container environment variable entries
- `manage_container_env` tool — add/remove container environment variables
- `list_container_mounts` tool — list container volume mount definitions
- `manage_container_mount` tool — add/remove container volume mounts
- `bandwidth_test` tool — run RouterOS bandwidth test to a remote btest server
- `fetch_url` tool — send HTTP/HTTPS request from the router using /tool/fetch
- `list_connections` tool — list active firewall connection tracking entries
- `list_interface_lists` tool — list all interface lists
- `manage_interface_list` tool — add/remove interface lists
- `manage_interface_list_member` tool — add/remove interfaces from interface lists
- `list_ppp_profiles` tool — list PPP profiles including built-in defaults
- `manage_ppp_profile` tool — add/update/remove PPP profiles

### Fixed
- `fetch_url` — RouterOS requires `http-method` in lowercase; uppercase values (`GET`/`POST`) were rejected with HTTP 400
- `fetch_url` — added `output=user` for inline body response; fixed file-save mode to use `output=file` + `dst-path` (was incorrectly setting `output=<filepath>`)
- `fetch_url` — RouterOS `/tool/fetch` returns a streaming array of progress sections; handler now finds the `finished` section and reads `code` (HTTP status) and `data` (body) from it

---

## [1.4.0] - 2026-05-24

### Added
- `list_user_groups` — list local user groups with policy bitmask (`/user/group`)
- `manage_user_group` — create, update, or remove user groups; idempotent by name; update action changes the policy string
- `get_upgrade_status` — check RouterOS and routerboard firmware upgrade availability and current channel
- `manage_upgrade` — trigger a package update check (`action=check`) or install an upgrade (`action=install`, destructive, reboots)
- `create_backup` — create a binary router config backup file with optional encryption password
- `export_config` — export running config as a RouterOS script text (`/export`); compact mode supported; optionally save to router file
- `list_log_rules` — list system logging rules with topic substring and action name filters
- `manage_log_rule` — add, remove, enable, or disable log rules; idempotent by topics+action composite key
- `list_log_actions` — list log action targets (memory, disk, remote syslog, etc.) with type filter
- `manage_log_action` — add or remove log action targets; idempotent by name; type required for add
- `manage_ntp_client` — configure NTP client: enable/disable, set servers, mode, and VLAN source interface; complements `get_ntp_settings`

---

## [1.3.0] - 2026-05-24

### Added
- `list_pppoe_clients` — list PPPoE client interfaces with connection state; filters by parent interface and status (connected/disconnected/all); supports pagination
- `manage_pppoe_client` — add, update, or remove PPPoE client interfaces (idempotent by name+interface+user for add; no_change guard on update; password always written when provided since RouterOS does not expose it in GET)
- `list_ovpn_clients` — list OpenVPN client interfaces with connection state and remote endpoint; supports pagination
- `manage_ovpn_client` — add, update, or remove OpenVPN client interfaces (idempotent by name+connectTo for add; no_change guard on update; certificate and credential references)
- `get_ovpn_server` — read OpenVPN server configuration (port, mode, protocol, certificate, cipher, auth, enabled state)
- `manage_ovpn_server` — enable/disable the OpenVPN server or update its configuration (port, mode, protocol, certificate, cipher, auth); enable/disable are idempotent; set returns no_change when all fields already match

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

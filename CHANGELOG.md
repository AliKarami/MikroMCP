# Changelog

All notable changes to MikroMCP are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

Each release section covers changes **since the previous release only**.

---

## [Unreleased]

### Added
- `GET /healthz` endpoint on the HTTP transport for container liveness/readiness probes (unauthenticated, not rate-limited).
- `MIKROMCP_SNAPSHOT_RETENTION_DAYS` (default 30) — config snapshots older than this are pruned at server startup.

### Changed
- Server version is derived from `package.json` (generated `src/version.ts`) instead of a hardcoded string.

### Fixed
- Read tools now retry on transient HTTP 5xx / timeout / busy responses (the retry engine previously honoured only raw network errors).
- Circuit breaker half-open state now admits a single recovery probe at a time.
- `apply_plan` records real per-step duration in the write journal instead of a hardcoded zero.
- Audit log and write journal now redact VPN/crypto secrets (WireGuard private keys, IPSec PSK, SNMP community strings).
- HTTP rate-limiter no longer leaks memory — stale per-IP windows are swept periodically.
- The pooled RouterOS REST client is now evicted after a router authentication failure, so the next call rebuilds it with fresh credentials.
- `bulk_execute` fleet operations are now written to the audit log (previously produced no audit trail).
- `apply_plan` sub-steps now run through the per-router circuit breaker, so a plan fails fast against a router the breaker already knows is down.

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

# MikroMCP Roadmap

This document describes what has been built and what is planned. Milestones are intentionally scoped so each one ships working, testable software on its own.

---

## ✅ v0.1 — Foundation

**Goal:** Prove the architecture end-to-end with a small set of useful tools.

- **Transport:** stdio (JSON-RPC 2.0 over stdin/stdout)
- **Infrastructure:** circuit breaker (per-router), retry engine (exponential backoff + jitter), connection pool, env-var credential source, structured logging (pino), correlation IDs
- **Tools:** `get_system_status`, `list_interfaces`, `create_vlan`, `manage_ip_address`

---

## ✅ v0.2 — Routing, Firewall & DHCP

**Goal:** Cover the most-changed parts of a router config.

- **Transport:** HTTP/SSE added (`MIKROMCP_TRANSPORT=http`, stateless StreamableHTTPServerTransport)
- **Tools:**
  - `list_dhcp_leases` — DHCP lease table with server/status/MAC filtering
  - `list_routes`, `manage_route` — static routes with idempotency, routing table support, plain-IP auto-CIDR
  - `list_firewall_rules`, `manage_firewall_rule` — filter and NAT tables, comment-based idempotency key

---

## ✅ v0.3 — Diagnostics & Day-to-Day Operations

**Goal:** Everything an operator reaches for first when something breaks, plus an escape hatch for tools not yet covered.

- **`run_command`** — general-purpose RouterOS console command tool via SSH; safety guardrails: command allowlist/denylist, output length cap, dry-run preview
- **`ping`** — send ICMP echo from the router (`/tool/ping`), return RTT stats and packet loss
- **`traceroute`** — path tracing from the router (`/tool/traceroute`)
- **`torch`** — real-time traffic monitor snapshot for an interface (`/tool/torch`)
- **`get_log`** — read and filter system log (`/log`); filter by topic, prefix, time range
- **`get_system_clock`**, **`set_system_clock`** — read/set system time and timezone (`/system/clock`)
- **`reboot`** — controlled router reboot with optional delay and dry-run
- **Existing tool improvements:** `list_interfaces` gained running-only filter and MAC address filter; `manage_firewall_rule` gained src/dst port ranges and in/out interface for NAT, plus CONFLICT detection on port/interface mismatch; `manage_ip_address` network auto-calculate edge cases hardened

---

## ✅ v0.4 — Network Services

**Goal:** WiFi, bridging, WireGuard, and DNS — the next most-configured subsystems after routing and firewall.

- **Infrastructure fixes (pre-existing bugs):**
  - RouterOS boolean/number values are returned as strings in some endpoints and as native types in others; audit all idempotency comparisons for type consistency (`=== "true"` not `=== true`) — currently causes false conflict reports in `interface-tools`, `route-tools`, and `ip-tools`
  - `ZodError` falls through `enrichError` as `INTERNAL`; map it to `VALIDATION` category so callers can distinguish bad input from server faults
  - Circuit breaker increments its failure count for `VALIDATION`, `NOT_FOUND`, `CONFLICT`, and `COMMAND_DENIED` errors — only router/network failures should trip the breaker
  - Retry engine wraps circuit execution; one read call can accumulate multiple failure counts — restructure so the circuit wraps the final retry attempt, not each individual attempt
  - Router registry silently swallows YAML parse errors; validate the loaded config with a Zod schema at startup and exit fast with a descriptive message on bad config
  - IP/CIDR regex in `ip-tools` and `route-tools` accepts values like `999.999.999.999/99`; replace with a proper CIDR parser
  - Verify `.proplist`/`.query` filter behavior in RouterOS REST — may require `POST /<path>/print` instead of `GET /<path>` for complex queries
- **Housekeeping:** Align `package.json` version, `McpServer` version string, README tool count, and wiki Roadmap page — currently all report different values
- **Bridge:**
  - `list_bridges` — bridge interfaces and their port members
  - `manage_bridge` — create/remove bridge interfaces
  - `manage_bridge_port` — add/remove ports from a bridge
- **WiFi / Wireless:**
  - `list_wifi_interfaces` — AP interfaces, bands, SSIDs, current clients (`/interface/wifi` or `/interface/wireless`)
  - `list_wifi_clients` — connected stations with signal, TX/RX rates
  - `manage_wifi_interface` — enable/disable, change SSID/band settings
- **WireGuard:**
  - `list_wireguard_interfaces` — WireGuard interfaces and their status
  - `list_wireguard_peers` — peer list with last handshake, transfer stats
  - `manage_wireguard_peer` — add/remove peers (idempotent by public key)
- **DNS:**
  - `list_dns_entries` — static DNS entries (`/ip/dns/static`)
  - `manage_dns_entry` — add/remove static DNS records (idempotent by name+type)
  - `get_dns_settings` — resolver config (upstream servers, cache TTL, allow remote requests)

---

## ✅ v0.5 — Advanced Firewall, Policy Routing & Security Hardening

**Goal:** Complete the firewall surface, add advanced routing primitives, and close the security gaps in the HTTP transport and `run_command`.

- ✅ **Firewall Mangle:**
  - `list_mangle_rules` — mangle rules in evaluation order
  - `manage_mangle_rule` — add/remove/disable/enable mangle rules (comment as idempotency key)
- ✅ **Firewall Address Lists:**
  - `list_address_list_entries` — entries across all address lists (`/ip/firewall/address-list`)
  - `manage_address_list_entry` — add/remove entries (idempotent by list+address)
- ✅ **Policy Routing:**
  - `list_routing_rules` — routing rules (`/routing/rule`)
  - `manage_routing_rule` — add/remove/enable/disable routing rules (composite key)
  - `list_routing_tables` — custom routing tables (`/routing/table`)
  - `manage_routing_table` — create/remove routing tables
- ✅ **Routing Protocols (read-only first):**
  - `list_bgp_peers` — BGP sessions with state, prefix counts, uptime (RouterOS 7+)
  - `list_ospf_neighbors` — OSPF neighbor state and adjacency info (RouterOS 7+)
- ✅ **Security hardening (v0.5b):**
  - HTTP transport: body size limit (`MIKROMCP_HTTP_MAX_BODY_BYTES`, default 1 MB), bind host (`MIKROMCP_BIND_HOST`, default `127.0.0.1`), per-IP rate limiting (`MIKROMCP_HTTP_RATE_LIMIT_RPM`, default 60 req/min, 0 = disabled)
  - `run_command` policy modes documented in `routers.example.yaml`: default-allow with builtin denylist, strict allowlist mode (`cmdAllow`), per-router additional deny patterns
  - SSH: per-command timeout (`MIKROMCP_SSH_COMMAND_TIMEOUT_MS`, default 30 s), output cap (`MIKROMCP_SSH_MAX_OUTPUT_BYTES`, default 512 KB with `[OUTPUT TRUNCATED]` marker), guaranteed `conn.end()` cleanup on all error paths, host-key fingerprint pinning (`sshFingerprint` per router, SHA256 hex)
  - TLS: certificate fingerprint pinning (`tls.fingerprint` per router, SHA256 hex), startup warning logged when `rejectUnauthorized=false`

---

## ✅ v0.6 — Automation & System Management

**Goal:** The scripting, scheduling, and lifecycle management layer — what separates a managed router from an automated one.

- **Scripts:**
  - `list_scripts` — RouterOS scripts (`/system/script`)
  - `manage_script` — create/update/remove scripts
  - `run_script` — execute a named script with dry-run support and output capture
- **Scheduler:**
  - `list_scheduled_jobs` — scheduler entries with next-run time (`/system/scheduler`)
  - `manage_scheduled_job` — create/update/remove scheduled jobs
- **Packages:**
  - `list_packages` — installed packages with version and enabled status (`/system/package`)
  - `manage_package` — enable/disable packages (changes take effect after reboot)
- **Files:**
  - `list_files` — router filesystem listing (`/file`)
  - `get_file_content` — read a text file's contents
  - `upload_file` — upload content as a router file (for scripts, config snippets)
- **Containers:**
  - `list_containers` — container instances with status and resource usage (`/container`)
  - `manage_container` — start/stop/remove containers

---

## ✅ v0.7 — Identity, Auth & Audit

**Goal:** Establish trust boundaries before expanding dangerous or admin-level surfaces. Nothing from this milestone onward ships without these foundations.

- **HTTP bearer token authentication** — bcrypt token verification (cost 12); HTTP transport requires `Authorization: Bearer <token>`; stdio falls back to a built-in `superadmin` identity
- **RBAC identity enforcement** — per-identity `allowedRouters` and `allowedToolPatterns` (wildcard `*` supported); `authz.ts` middleware enforces at call time
- **Dual-sink audit log** — every write/destructive call logged to pino (structured) and an NDJSON file with identity, tool, router, params (credentials redacted), and outcome
- **Two-step confirmation gate** — destructive tools require a `confirmationToken` (HMAC-SHA256, 5-min TTL, single-use); `operator` and `readonly` roles must confirm; `admin`/`superadmin` bypass
- **Credential surface reduction** — SSH and FTP adapters (`SshClient`, `FtpClient`) wrap credentials in a closure; tool handlers never touch secrets directly

---

## ✅ v0.8 — Change Safety & Rollback

**Goal:** Move "backup before write" and `plan/apply` here, where identity and audit already exist to make them meaningful.

- **Snapshot engine** — capture the full state of a RouterOS section (firewall chain, routing table, IP addresses, DHCP config) before any write
- **Before/after diff normalization** — structured diff of RouterOS payloads using the same field-normalization logic as idempotency checks
- **Write journal** — append-only record of every write with the before-snapshot path and enough metadata for rollback
- **`plan_changes`, `apply_plan`, `rollback_change`** — dry-run a set of writes against a live snapshot, apply with confirmation, roll back by ID
- **Maintenance-window guardrails** — block disruptive actions (reboot, firewall flush, route removal) outside a declared window

---

## ✅ v0.9 — Fleet Operations & Remaining RouterOS Surface

**Goal:** After RBAC and snapshots exist, safely expand to the remaining dangerous surfaces and fleet-level operations.

- **IPSec/VPN:** `list_ipsec_peers`, `list_ipsec_policies`, `manage_ipsec_peer`
- **Certificates:** `list_certificates`, `manage_certificate`
- **Users:** `list_users`, `manage_user`
- **DHCP Servers & Pools:** `list_dhcp_servers`, `manage_dhcp_server`, `list_dhcp_pools`, `manage_dhcp_pool`
- **Queues/QoS:** `list_queues`, `manage_queue`
- **VRRP:** `list_vrrp_instances`, `manage_vrrp_instance`
- **SNMP & NTP:** `get_snmp_settings`, `get_ntp_settings`
- **Netwatch:** `list_netwatch_entries`, `manage_netwatch_entry`
- **Discovery & ARP:** `list_neighbors`, `list_arp_entries`
- **Fleet operations:** `bulk_execute` — fan-out a tool call across multiple routers by ID or tag with configurable concurrency; aggregates results with per-router status and partial-failure handling
- **Health checks:** `check_router_health` — router reachability probe, REST/SSH capability detection, RouterOS version compatibility check

---

## 🔜 v1.0 — Production Release

**Goal:** Distribution, operability, and ecosystem milestone. v1.0 is about making MikroMCP production-ready for teams and accessible to individual users — not adding new router surfaces.

- **Prometheus metrics** — `/metrics`, `/healthz`, `/readyz` endpoints: tool call latency, circuit breaker state, error rates per router, router availability
- **RouterOS CHR integration test harness** — CHR in Docker for end-to-end CI without real hardware; REST adapter tests with real parsed payloads; idempotency edge-case coverage
- **`mikromcp doctor` (expanded)** — interactive setup wizard: detect missing env vars and config, generate a starter `routers.yaml`, test router connectivity, verify API credentials, configure and register with Claude Desktop / Claude Code, check for MikroMCP updates, and summarise overall health with actionable fix suggestions
- **Onboarding for non-experts** — step-by-step wiki guides (RouterOS API enable, credential setup, `routers.yaml` authoring, connecting to Claude Desktop / Claude Code / Codex / Cursor); `mikromcp init` wizard as the CLI entry point for first-time setup
- **GitHub Releases + multi-arch binaries** — automated release workflow triggered by version tags: build standalone binaries (Linux x64/arm64, macOS x64/arm64, Windows x64) via `pkg` or `bun build --compile`; attach to the GitHub Release; generate a changelog from conventional commits
- **Docker Hub & GHCR images** — CI publishes `mikromcp:latest` and `mikromcp:<version>` to both Docker Hub and GitHub Container Registry on each release tag; multi-arch manifest (linux/amd64, linux/arm64); updated `docker-compose.example.yml` referencing the public images (requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets configured in GitHub repo settings → Secrets and variables → Actions)
- **Release artifact automation in CI/CLAUDE.md** — CI workflow enforces that every release tag triggers: version bump, binary builds, Docker pushes, GitHub Release creation, and wiki sync; `CLAUDE.md` documents the release checklist so future contributors know what to update
- **Stability policy** — tool schema stability contract and compatibility matrix
- **Security docs** — least-privilege RouterOS policy templates, threat model, deployment guide

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

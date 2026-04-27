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

## 🔜 v0.4 — Network Services

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

## 🔜 v0.5 — Advanced Firewall, Policy Routing & Security Hardening

**Goal:** Complete the firewall surface, add advanced routing primitives, and close the security gaps in the HTTP transport and `run_command`.

- **Firewall Mangle:**
  - `list_mangle_rules` — mangle rules in evaluation order
  - `manage_mangle_rule` — add/remove/disable/enable mangle rules (comment as idempotency key)
- **Firewall Address Lists:**
  - `list_address_list_entries` — entries across all address lists (`/ip/firewall/address-list`)
  - `manage_address_list_entry` — add/remove entries (idempotent by list+address)
- **Policy Routing:**
  - `list_routing_rules` — routing rules (`/routing/rule`)
  - `manage_routing_rule` — add/remove routing rules
  - `list_routing_tables` — custom routing tables (`/routing/table`)
  - `manage_routing_table` — create/remove routing tables
- **Routing Protocols (read-only first):**
  - `list_bgp_peers` — BGP sessions with state, prefix counts, uptime
  - `list_ospf_neighbors` — OSPF neighbor state and adjacency info
- **Security hardening:**
  - HTTP transport: enforce body size limit, add `bindHost` config option (`127.0.0.1` by default for new installs), basic rate limiting
  - `run_command` policy documentation and hardening — clarify that default-allow + builtin denylist is intentional; document the allowlist mode (`cmdAllow`) as the stricter opt-in and add config examples for both modes
  - SSH: host-key pinning (reject unknown hosts by default), per-command execution timeout, streaming output cap, guaranteed resource cleanup on error paths
  - TLS: CA pinning and certificate fingerprint pinning as first-class config options; escalate `rejectUnauthorized: false` from a documented example to a loud opt-in with a deprecation warning

---

## 🔜 v0.6 — Automation & System Management

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

## 🔜 v0.7 — Enterprise Security & Identity

**Goal:** Multi-tenant deployments, stronger credential management, and VPN.

- **Vault credential source** — resolve router credentials from HashiCorp Vault (KV v2) in addition to env vars
- **RBAC / identity enforcement** — per-identity allowed routers, tool patterns, and action scopes; credentials passed as MCP request context; *prerequisite before expanding dangerous write tools beyond this milestone*
- **HTTP transport authentication** — bearer token or mTLS for the HTTP/SSE endpoint; prerequisite before any non-localhost deployment
- **Destructive-op confirmation workflow** — structured confirmation step for `reboot`, route removal, firewall removal, and IP removal; gated behind an RBAC scope so unattended automation can opt out intentionally
- **Backup-before-write** — snapshot the affected resource set (firewall chain, route table, IP addresses, DHCP leases) before applying any write; include the snapshot path in the structured result so callers can roll back
- **IPSec/VPN:**
  - `list_ipsec_peers` — IPSec peer configuration and state (`/ip/ipsec`)
  - `list_ipsec_policies` — active IPSec policies
  - `manage_ipsec_peer` — add/remove IPSec peer definitions
- **Certificates:**
  - `list_certificates` — installed certificates with validity and usage (`/certificate`)
  - `manage_certificate` — import, sign, remove certificates
- **Users:**
  - `list_users` — router users and groups (`/user`)
  - `manage_user` — add/remove users and group membership (idempotent)

---

## 🔜 v1.0 — Production Hardening

**Goal:** The stability, observability, and ecosystem milestone for teams running MikroMCP in production.

- **Config snapshot & diff** — snapshot a router's full config at a point in time; diff two snapshots to see what changed; restore from snapshot (with dry-run)
- **`plan/apply` diff tools** — dry-run a set of write operations against a snapshotted baseline; produce a structured human-readable diff; apply with a single confirmation (extends the snapshot/diff work above)
- **Bulk operations** — apply a tool call across multiple routers in parallel (fan-out); aggregate results with per-router status
- **Integration test harness** — RouterOS CHR running in Docker for end-to-end tests without real hardware; CI job that runs the full tool suite against CHR
  - REST adapter tests with mocked HTTP responses (currently only tool-level `routerClient` mocks exist)
  - Idempotency tests using real parsed RouterOS payloads — including boolean/number field edge cases that the current unit tests do not cover
  - Negative tests: malformed `routerId`, invalid CIDR, invalid router config at startup, HTTP auth bypass attempts, `run_command` policy bypass attempts
- **Prometheus metrics endpoint** — expose tool call latency, circuit breaker state, error category counts, and router availability as `/metrics` (when using HTTP transport)
- **NPM package publication** — publish to npm so `npx mikromcp` works out of the box without cloning

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

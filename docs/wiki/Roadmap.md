# Roadmap

Milestones are intentionally scoped so each one ships working, testable software on its own. See [ROADMAP.md](https://github.com/AliKarami/MikroMCP/blob/main/ROADMAP.md) in the repository for the authoritative version.

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

- **`run_command`** — general-purpose RouterOS console command tool via SSH; command allowlist/denylist policy, output cap at 4000 chars, dry-run preview
- **`ping`** — ICMP echo from the router (`/tool/ping`), returns RTT stats and packet loss
- **`traceroute`** — path tracing from the router (`/tool/traceroute`)
- **`torch`** — real-time traffic monitor snapshot for an interface (`/tool/torch`)
- **`get_log`** — read and filter system log (`/log`); filter by topic, prefix, time range
- **`get_system_clock`**, **`set_system_clock`** — read/set system time and timezone (`/system/clock`)
- **`reboot`** — controlled router reboot with optional delay and dry-run
- **Existing tool improvements:** `list_interfaces` gained running-only and MAC address filters; `manage_firewall_rule` gained src/dst port ranges and in/out interface for NAT rules, plus CONFLICT detection on port/interface mismatch

---

## ✅ v0.4 — Network Services

**Goal:** WiFi, bridging, WireGuard, and DNS — the next most-configured subsystems after routing and firewall.

- **Infrastructure fixes:** RouterOS boolean/number type normalization in idempotency comparisons; `ZodError` now maps to `VALIDATION` (not `INTERNAL`); circuit breaker no longer trips on `VALIDATION`/`NOT_FOUND`/`CONFLICT` errors; circuit breaker now wraps the full retry sequence instead of each individual attempt; router registry validates YAML config with Zod at startup and exits fast on bad config; IP/CIDR validation replaced with a proper octet/prefix parser
- **Bridge:** `list_bridges`, `manage_bridge`, `manage_bridge_port`
- **WiFi / Wireless:** `list_wifi_interfaces`, `list_wifi_clients`, `manage_wifi_interface`
- **WireGuard:** `list_wireguard_interfaces`, `list_wireguard_peers`, `manage_wireguard_peer`
- **DNS:** `list_dns_entries`, `manage_dns_entry`, `get_dns_settings`

---

## ✅ v0.5 — Advanced Firewall, Policy Routing & Security Hardening

**Goal:** Complete the firewall surface, add advanced routing primitives, and close the security gaps in the HTTP transport and `run_command`.

- **Firewall Mangle:** `list_mangle_rules`, `manage_mangle_rule`
- **Firewall Address Lists:** `list_address_list_entries`, `manage_address_list_entry`
- **Policy Routing:** `list_routing_rules`, `manage_routing_rule`, `list_routing_tables`, `manage_routing_table`
- **Routing Protocols (read-only):** `list_bgp_peers`, `list_ospf_neighbors`

---

## ✅ v0.6 — Automation & System Management

**Goal:** The scripting, scheduling, and lifecycle management layer.

- **Scripts:** `list_scripts`, `manage_script`, `run_script`
- **Scheduler:** `list_scheduled_jobs`, `manage_scheduled_job`
- **Packages:** `list_packages`, `manage_package`
- **Files:** `list_files`, `get_file_content`, `upload_file`
- **Containers:** `list_containers`, `manage_container`

---

## ✅ v0.7 — Identity, Auth & Audit

**Goal:** Establish trust boundaries before expanding dangerous or admin-level surfaces.

- **HTTP bearer token authentication** — bcrypt token verification; HTTP transport requires `Authorization: Bearer <token>`; stdio uses a built-in `superadmin` identity
- **RBAC identity enforcement** — per-identity `allowedRouters` and `allowedToolPatterns`; `authz.ts` middleware enforces at call time
- **Dual-sink audit log** — every write/destructive call logged to pino and an NDJSON file with identity, tool, router, params (credentials redacted), and outcome
- **Two-step confirmation gate** — destructive tools require a `confirmationToken` (HMAC-SHA256, 5-min TTL, single-use)
- **Credential surface reduction** — SSH and FTP adapters wrap credentials in a closure; tool handlers never touch secrets

---

## ✅ v0.8 — Change Safety & Rollback

**Goal:** Snapshot, diff, and rollback before expanding dangerous router surfaces.

- **Snapshot engine** — capture RouterOS section state before writes
- **Before/after diff normalization** — structured diff of RouterOS payloads
- **Write journal** — append-only record of writes with rollback metadata
- **`plan_changes`, `apply_plan`, `rollback_change`** tools
- **Maintenance-window guardrails** — block disruptive actions outside declared windows

---

## ✅ v0.9 — Fleet Operations & Remaining RouterOS Surface

**Goal:** After RBAC and snapshots exist, safely expand to remaining admin surfaces.

- **IPSec/VPN:** `list_ipsec_peers`, `list_ipsec_policies`, `manage_ipsec_peer`
- **Certificates:** `list_certificates`, `manage_certificate`
- **Users:** `list_users`, `manage_user`
- **DHCP Servers & Pools:** `list_dhcp_servers`, `manage_dhcp_server`, `list_dhcp_pools`, `manage_dhcp_pool`
- **Queues/QoS:** `list_queues`, `manage_queue`
- **VRRP:** `list_vrrp_instances`, `manage_vrrp_instance`
- **SNMP & NTP:** `get_snmp_settings`, `get_ntp_settings`
- **Netwatch:** `list_netwatch_entries`, `manage_netwatch_entry`
- **Discovery & ARP:** `list_neighbors`, `list_arp_entries`
- **Fleet operations:** `bulk_execute` — fan-out across multiple routers by ID or tag with concurrency limits and partial-failure handling
- **Health checks:** `check_router_health` — reachability probe, REST/SSH capability detection, version compatibility

---

## 🔜 v1.0 — Production Release

**Goal:** Distribution, operability, and ecosystem milestone.

- **Prometheus metrics** — `/metrics`, `/healthz`, `/readyz` endpoints
- **RouterOS CHR integration test harness** — end-to-end CI without real hardware
- **Distribution** — npm publication, Docker image, example systemd unit
- **`mikromcp doctor`** — config/env/router capability validation
- **Stability policy** — tool schema stability contract and compatibility matrix
- **Security docs** — least-privilege RouterOS policies, threat model, deployment guide

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

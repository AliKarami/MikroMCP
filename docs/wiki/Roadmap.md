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

## 🔜 v0.4 — Network Services

**Goal:** WiFi, bridging, WireGuard, and DNS — the next most-configured subsystems after routing and firewall.

- **Bridge:** `list_bridges`, `manage_bridge`, `manage_bridge_port`
- **WiFi / Wireless:** `list_wifi_interfaces`, `list_wifi_clients`, `manage_wifi_interface`
- **WireGuard:** `list_wireguard_interfaces`, `list_wireguard_peers`, `manage_wireguard_peer`
- **DNS:** `list_dns_entries`, `manage_dns_entry`, `get_dns_settings`

---

## 🔜 v0.5 — Advanced Firewall & Policy Routing

**Goal:** Complete the firewall surface and add advanced routing primitives.

- **Firewall Mangle:** `list_mangle_rules`, `manage_mangle_rule`
- **Firewall Address Lists:** `list_address_list_entries`, `manage_address_list_entry`
- **Policy Routing:** `list_routing_rules`, `manage_routing_rule`, `list_routing_tables`, `manage_routing_table`
- **Routing Protocols (read-only):** `list_bgp_peers`, `list_ospf_neighbors`

---

## 🔜 v0.6 — Automation & System Management

**Goal:** The scripting, scheduling, and lifecycle management layer.

- **Scripts:** `list_scripts`, `manage_script`, `run_script`
- **Scheduler:** `list_scheduled_jobs`, `manage_scheduled_job`
- **Packages:** `list_packages`, `manage_package`
- **Files:** `list_files`, `get_file_content`, `upload_file`
- **Containers:** `list_containers`, `manage_container`

---

## 🔜 v0.7 — Enterprise Security & Identity

**Goal:** Multi-tenant deployments, stronger credential management, and VPN.

- **Vault credential source** — resolve credentials from HashiCorp Vault (KV v2)
- **RBAC / identity enforcement** — per-identity allowed routers, tool patterns, action scopes
- **IPSec/VPN:** `list_ipsec_peers`, `list_ipsec_policies`, `manage_ipsec_peer`
- **Certificates:** `list_certificates`, `manage_certificate`
- **Users:** `list_users`, `manage_user`

---

## 🔜 v1.0 — Production Hardening

**Goal:** Stability, observability, and ecosystem milestone for teams running MikroMCP in production.

- **Config snapshot & diff** — snapshot, diff, and restore router configs
- **Bulk operations** — fan-out a tool call across multiple routers in parallel
- **Integration test harness** — RouterOS CHR in Docker for end-to-end CI
- **Prometheus metrics endpoint** — tool call latency, circuit breaker state, error rates per router
- **NPM package publication** — `npx mikromcp` without cloning

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

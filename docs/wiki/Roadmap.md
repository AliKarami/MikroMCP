# Roadmap

Milestones are intentionally scoped so each one ships working, testable software on its own. See [ROADMAP.md](https://github.com/AliKarami/MikroMCP/blob/main/ROADMAP.md) in the repository for the authoritative version with full milestone details.

v1.0 is released and stable. Future work is tracked in new milestones.

---

## ✅ v0.1 — Foundation

Stdio transport, circuit breaker, retry engine, structured logging, correlation IDs.  
Tools: `get_system_status`, `list_interfaces`, `create_vlan`, `manage_ip_address`.

---

## ✅ v0.2 — Routing, Firewall & DHCP

HTTP/SSE transport. Tools: `list_dhcp_leases`, `list_routes`, `manage_route`, `list_firewall_rules`, `manage_firewall_rule`.

---

## ✅ v0.3 — Diagnostics & Day-to-Day Operations

SSH adapter. Tools: `run_command`, `ping`, `traceroute`, `torch`, `get_log`, `get_system_clock`, `set_system_clock`, `reboot`.

---

## ✅ v0.4 — Network Services

Bridge, WiFi/Wireless, WireGuard, DNS tools. Infrastructure fixes: boolean normalization, ZodError mapping, circuit breaker scope, YAML config validation.

---

## ✅ v0.5 — Advanced Firewall, Policy Routing & Security Hardening

Tools: `list_mangle_rules`, `manage_mangle_rule`, `list_address_list_entries`, `manage_address_list_entry`, `list_routing_rules`, `manage_routing_rule`, `list_routing_tables`, `manage_routing_table`, `list_bgp_peers`, `list_ospf_neighbors`.

---

## ✅ v0.6 — Automation & System Management

Tools: `list_scripts`, `manage_script`, `run_script`, `list_scheduled_jobs`, `manage_scheduled_job`, `list_packages`, `manage_package`, `list_files`, `get_file_content`, `upload_file`, `list_containers`, `manage_container`.

---

## ✅ v0.7 — Identity, Auth & Audit

HTTP bearer token auth (bcrypt), RBAC per-identity `allowedRouters` / `allowedToolPatterns`, dual-sink audit log (pino + NDJSON), two-step HMAC confirmation gate for destructive tools, SSH/FTP credential encapsulation.

---

## ✅ v0.8 — Change Safety & Rollback

Snapshot engine, before/after diff normalization, append-only write journal, maintenance-window guardrails.  
Tools: `plan_changes`, `apply_plan`, `rollback_change`.

---

## ✅ v0.9 — Fleet Operations & Remaining RouterOS Surface

IPSec, Certificates, Users, DHCP Servers & Pools, Queues/QoS, VRRP, SNMP, NTP, Netwatch, Discovery & ARP.  
Tools: `check_router_health`, `bulk_execute`.

---

## ✅ v1.0 — Production Release

`mikromcp init` setup wizard, `mikromcp doctor` health checker, `mikromcp update` self-update, npm package, multi-arch Docker images and standalone binaries, Streamable HTTP transport, stability policy, security docs.

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

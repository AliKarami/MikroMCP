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

## ✅ v1.1 — Correctness, Security Hardening & New Orchestration Features

Retry engine honours `MikroMCPError.recoverability`; circuit breaker half-open single-probe gate; `apply_plan` real duration + circuit breaker for sub-steps.  
Security: secret redaction in audit/journal, rate-limiter memory fix, REST client eviction on auth failure, dotenv audit-path fix.  
Operability: `/healthz` probe, `/metrics` Prometheus endpoint, snapshot retention pruning, async file I/O.  
Orchestration: fleet-confirmed destructive `bulk_execute`, expanded rollback semantic keys, `bulk_execute` audit trail.  
Config: version from `package.json`, `mikromcp init` allow-all fix, `pagination` config removed.

---

## ✅ v1.2 — DHCP & Interface Completeness

New tools: `manage_vlan` (full VLAN lifecycle, replaces `create_vlan`), `list_ip_pools`/`manage_ip_pool` (renamed from `list_dhcp_pools`/`manage_dhcp_pool`), `manage_dhcp_lease` (make-static / remove, MAC-keyed idempotency), `list_dhcp_clients`/`manage_dhcp_client` (DHCP client configuration per interface), `list_ip_services`/`manage_ip_service` (view and toggle RouterOS IP services without port changes).  
Improvements: `list_dhcp_leases` gains `leaseType` filter; `list_dhcp_servers` gains `offset` pagination parameter.

---

## ✅ v1.3 — PPPoE & OpenVPN

`list_pppoe_clients`, `manage_pppoe_client` — PPPoE client management (add/update/remove, idempotent, no_change guard on update).
`list_ovpn_clients`, `manage_ovpn_client` — OpenVPN client management (add/update/remove, idempotent, certificate references).
`get_ovpn_server`, `manage_ovpn_server` — OpenVPN server singleton (read config; enable/disable/set; idempotent).

---

## ✅ v1.4 — System Administration Depth

`list_user_groups`, `manage_user_group` — local user group management with policy bitmask.
`get_upgrade_status`, `manage_upgrade` — RouterOS upgrade check and install.
`create_backup`, `export_config` — binary backup and text config export.
`list_log_rules`, `manage_log_rule`, `list_log_actions`, `manage_log_action` — system logging configuration.
`manage_ntp_client` — NTP client configuration (complements `get_ntp_settings`).

---

## ✅ v1.5 — Container Depth & Diagnostics

`get_container_config`, `manage_container_config` — global container settings (registry, RAM, veth).
`list_container_envs`, `manage_container_env` — container environment variables.
`list_container_mounts`, `manage_container_mount` — container volume mounts.
`bandwidth_test`, `fetch_url`, `list_connections` — network diagnostic tools.
`list_interface_lists`, `manage_interface_list`, `manage_interface_list_member` — interface list management.
`list_ppp_profiles`, `manage_ppp_profile` — PPP profile management.
`delete_file` — delete router filesystem files.
`manage_dns_settings` — write DNS upstream servers, cache TTL, and allow-remote-requests.
`manage_ipsec_policy`, `manage_wireguard_interface` — IPSec policy and WireGuard interface management.

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

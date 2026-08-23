# Roadmap

Milestones are intentionally scoped so each one ships working, testable software on its own. See [ROADMAP.md](https://github.com/AliKarami/MikroMCP/blob/main/ROADMAP.md) in the repository for the authoritative version with full milestone details.

v1.9 is the current release. All milestones v0.1 through v1.9 are shipped — most recently SwOS switch support, which takes MikroMCP beyond RouterOS for the first time.

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

## ✅ v1.5 — Container Depth & Diagnostics (99 → 117 tools)

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

## ✅ v1.6.0 — Hardening & Developer Experience

A focused four-phase effort completed after v1.5 and released as v1.6.0:

**Phase 1 — Code Review Hardening:** Three bug fixes (audit redaction recursion, firewall idempotency address/protocol comparison, `bulk_execute` snapshot/journal on dry-run paths) and three refactors (shared `paginate` and `toolError` helpers; side-effect-free circuit breaker state getter).

**Phase 2 — Token & UX Optimisation:** Tool manifest trimmed ~14% in token count; `routerId` made optional when `MIKROMCP_DEFAULT_ROUTER` is set or only one router is configured; list tools deduplicate output by `.id`.

**Phase 3 — MikroMCP Usage Skill:** `skills/mikromcp/` — a Claude Code skill that guides LLMs in tool selection and safe workflows (dry-run → confirm → apply). `mikromcp init` and `mikromcp doctor` register the skill automatically. MCP server `instructions` field populated for clients that surface server hints.

**Phase 4 — Docs & Wiki Accuracy/Consistency Overhaul:** Full audit of all wiki pages against the live tool set (117 tools, v1.5.0). Stale counts and version strings corrected; `ROADMAP.md` milestone ordering fixed; cross-file consistency enforced across README, wiki, and CHANGELOG.

---

## ✅ v1.7 — Router Discovery (117 → 118 tools)

`list_routers` — read-only enumeration of the routers configured in `routers.yaml` (id, host, port, TLS status, tags, ROS version, and which is the default), so MCP clients can discover valid `routerId` values and tags for `bulk_execute` targeting without opening the config file. Reflects local config only: no RouterOS API call, no credentials in the response, and results are scoped to the caller's `allowedRouters`.

---

## ✅ v1.8 — Security & Correctness Hardening

No new tools. A security and correctness release covering the HTTP transport, the guard rails, and the change-safety subsystem.

**Transport & auth:** `GET /metrics` requires a bearer token when identities are configured; Streamable HTTP sessions are bound to the identity that created them and idle sessions are evicted; token lookups are cached by hash so bcrypt runs once per token; non-integer numeric env vars fail fast instead of becoming `NaN`.

**Guard rails:** `allowedToolPatterns` now uses an anchored glob (leading and mid-string wildcards previously matched everything); the `run_command` deny-list normalises path/space syntax and checks every `;`-separated segment, with `:execute`/`:parse` denied by default; TLS fingerprint pinning is enforced in the connection layer so it holds even with `rejectUnauthorized: false`.

**Change safety:** confirmation tokens are self-verifying HMACs that survive a restart; snapshots store only restorable configuration (dynamic records and runtime counters stripped) so rollback no longer writes back read-only fields; order-sensitive paths warn that rule order is not restored.

**Correctness:** tool risk annotations audited against a written rubric; `bulk_execute` tag targeting matches routers carrying **all** requested tags and runs through the full per-router safety stack; boolean record fields compared via a shared `isTrue()` helper; 64-bit counters keep precision.

---

## ✅ v1.9 — SwOS Switch Support (118 → 122 tools)

MikroMCP is no longer RouterOS-only. Devices declared with `deviceType: "swos"` speak MikroTik's undocumented `.b` HTTP API (digest auth) instead of the REST API, covering both SwOS and SwOS Lite.

`list_swos_endpoints`, `get_swos_status`, `get_swos_endpoint`, `write_swos_blob` — schema introspection, switch status, per-endpoint reads, and the whole-blob write the firmware requires.

**Experimental, and deliberately cautious.** The schema is reverse-engineered and pinned to a CSS610-8P-2S+ on SwOS Lite 2.21, so other models decode best-effort with unrecognised keys preserved verbatim. `write_swos_blob` defaults to `dryRun: true`, refuses a field the device did not send rather than injecting it, and verifies at runtime that the codec re-encodes *this* device's blob byte-for-byte before writing — a firmware that serializes differently fails loudly instead of corrupting the blob.

Every tool now declares a `platform`, and the executor refuses a RouterOS tool aimed at a switch or vice versa (`PLATFORM_MISMATCH`). Contributed by [@f0086](https://github.com/f0086).

---

## ✅ v1.10 — RouterOS CHR Integration Test Harness

End-to-end tests against a real RouterOS, in CI, without real hardware — the testing gap deferred at v1.0. `docker-compose.test.yml` boots a Cloud Hosted Router in Docker (QEMU, KVM-accelerated where available; the free CHR licence covers CI use), and `npm run test:integration` provisions it automatically and drives tool handlers against the live REST API: the full idempotency lifecycle (dry-run → create → already_exists → conflict → remove → not-found) for IP addresses, routes, firewall rules, DNS entries, VLANs, and VRRP instances, plus the complete change-safety cycle (`plan_changes` → `apply_plan` → snapshot → `rollback_change`). A smoke sweep runs every parameter-less read tool against the live router, so new list/get tools are covered automatically, and an opt-in second CHR covers fleet fan-out across two distinct routers. A label-gated `Integration` workflow runs the suite in CI in about 40 seconds.

Mocks structurally cannot see wire-format bugs — RouterOS sends every value as a string and the response parser converts them — and the harness proved it on its first runs: idempotency checks across twelve tools were comparing parsed values against wire strings and could never match, `list_connections` was entirely broken, three set-menu singletons could never write at all, `manage_ipsec_policy` created duplicate policies on re-add, and RouterOS 7.16+ had silently broken the OVPN server tools. All fixed with regression tests.

Contributed by [@f0086](https://github.com/f0086).

---

## Guiding principles

- **Each milestone ships working tools.** No half-finished features held open across versions.
- **Idempotency first.** Every write tool checks existing state before acting.
- **Dry-run on all write tools.** No exception.
- **Read-only before write.** New subsystems get list/read tools in one version, write tools in the next if needed.
- **`run_command` is a last resort.** Dedicated tools are always preferred; `run_command` exists for gaps, not for replacing proper tool coverage.

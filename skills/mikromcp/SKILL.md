---
name: mikromcp
description: Use when managing, configuring, or troubleshooting MikroTik RouterOS devices through the MikroMCP server — picking the right tool, running safe (dry-run, confirmed, rollback-able) changes, fleet operations, and diagnosing network issues.
---

# Driving MikroMCP

MikroMCP exposes MikroTik RouterOS management as MCP tools (over stdio or HTTP).
This skill is about operating those tools well and safely. It does not reproduce
RouterOS documentation — when you need to know what a RouterOS field means, see
`references/routeros-docs.md` and fetch the linked official page.

## When to use

- Configuring, inspecting, or troubleshooting a MikroTik router via MikroMCP tools.
- Rolling a change across many routers.

## When not to use

- Devices that are not MikroTik/RouterOS.
- Tasks with no MikroMCP server connected.

## First moves

1. Establish the target router. Tools take an optional `routerId`. If omitted,
   MikroMCP uses `MIKROMCP_DEFAULT_ROUTER`, or the sole configured router. If
   several routers exist and none is defaulted, ask which one.
2. Orient before changing anything: `get_system_status`, then `list_interfaces`
   (and the relevant `list_*` for the area you're touching).

## Golden rules (the safety spine)

1. **Reads are safe; treat every write as consequential.**
2. **Dry-run first.** Call a write tool with `dryRun: true`, show the diff, then
   apply for real. Never skip this for a non-trivial change.
3. **Confirmation tokens.** Destructive tools may require a two-step confirm: the
   first call returns an approval requirement + token; repeat the call with
   `confirmationToken`. This is a guardrail — explain it, don't try to bypass it.
4. **Writes are idempotent.** `already_exists` and `no_change` are SUCCESS, not
   errors. A `CONFLICT` means the resource exists with different config — resolve
   it deliberately (see `references/safety-and-recovery.md`).
5. **Rollback exists.** Write tools snapshot+journal first. To undo, use
   `rollback_change` with the journal ID. Know this before bulk changes.
6. **Prefer dedicated tools over `run_command`.** Use `run_command` only when no
   dedicated tool covers the need.

## Intent → tool quick index

| I want to… | Tool |
|---|---|
| See device health/uptime/version | `get_system_status` |
| List interfaces | `list_interfaces` |
| Add/serve an IP on an interface | `manage_ip_address` |
| Block/allow traffic | `manage_firewall_rule` |
| Port-forward / NAT | `manage_firewall_rule` (table `nat`) |
| Add a static route | `manage_route` |
| Add a DNS record | `manage_dns_entry` |
| See/assign DHCP leases | `list_dhcp_leases`, `manage_dhcp_lease` |
| See who's connected (WiFi) | `list_wifi_clients` |
| Test connectivity | `ping`, `traceroute` |
| Read the same data across many routers | `bulk_read` |
| Run a change across many routers | `bulk_execute` |
| Undo a change | `rollback_change` |

Full enumeration of every tool by family: `references/tool-map.md`.

## Core workflows

### Make a safe config change
1. `list_*` the area to capture current state.
2. Call the `manage_*` tool with `dryRun: true`; read the returned diff.
3. If a confirmation token is required, re-issue with `confirmationToken`.
4. Apply for real; confirm the `action` in the result (`created`/`updated`).
5. Note the journal ID in case you need `rollback_change`.
6. Re-read with the same `list_*` and compare with the intent — RouterOS has no
   commit step, so this is the only check that the change landed as meant.

### Diagnose connectivity
1. `get_system_status` and `list_interfaces` to confirm links are up.
2. `ping` the target from the router; `traceroute` if it fails partway.
3. Check `list_routes`, `list_firewall_rules`, `list_dns_entries` as the symptom
   suggests. Cross-check field meanings via `references/routeros-docs.md`.

### Fleet rollout
1. Capture current state across the fleet with `bulk_read` (read-only tools
   only; it refuses writes and `ping`/`traceroute`/`torch`/`bandwidth_test`).
2. Validate the change on ONE router first (dry-run → apply).
3. `bulk_execute` with the tool + params, targeting routerIds or a tag.
4. For any write tool, complete the fleet confirmation-token step: tell the user which
   routers and what change the token covers, and re-submit only after they agree.
5. Review per-router succeeded/failed counts; `rollback_change` per-router if needed.

### Recover from an error
1. Read the error `code`/`category` and `suggestedAction`.
2. Map it to a next step via the error→action table in
   `references/safety-and-recovery.md`.

## Router permissions by transport

- `run_command`, `export_config` and `ping` log in over SSH: the router user's
  group needs the `ssh` policy, and a key in `/user ssh-keys` turns off password
  login for that user (`/ip ssh password-authentication`).
- `traceroute`, `torch` and every other tool run over REST: no `ssh` needed, but
  `traceroute` and `torch` need `test`, and `torch` also `sniff`.

## Pointers

- Need a tool not in the quick index → `references/tool-map.md`.
- Need RouterOS field meaning, defaults, or version differences →
  `references/routeros-docs.md` (fetch the linked page; don't guess).
- Hit an error, a CONFLICT, or a destructive/confirmation flow →
  `references/safety-and-recovery.md`.

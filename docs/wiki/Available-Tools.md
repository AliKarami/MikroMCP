# Available Tools

All 117 tools exposed by MikroMCP. Every tool requires a `routerId` parameter (string) that matches an entry in your `config/routers.yaml`.

Read tools are safe to call freely — they carry auto-retry with exponential backoff. Write tools are idempotent unless noted, and all write tools support `dryRun: true` to preview changes without applying them.

---

## System

### `get_system_status` — Read

CPU load, memory, uptime, firmware version, and router identity in one call.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "What's the CPU and memory usage on core-01?"

---

### `get_system_clock` — Read

Read the current date, time, and timezone from the router.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "What time does edge-01 think it is?"

---

### `set_system_clock` — Write · Idempotent

Set the system date, time, and/or timezone. Returns `already_set` if no change is needed.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `date` | string | — | RouterOS date format: `jan/02/2006` |
| `time` | string | — | RouterOS time format: `15:04:05` |
| `timeZoneName` | string | — | IANA timezone name e.g. `Europe/London`, `UTC` |
| `dryRun` | boolean | `false` | Preview changes without applying |

At least one of `date`, `time`, or `timeZoneName` must be provided.

**Example prompt:** "Set the timezone on core-01 to Europe/Helsinki."

---

### `reboot` — Write · Destructive

Trigger a controlled router reboot with an optional delay. Use this instead of `run_command` for reboots — `run_command`'s built-in deny list blocks `/system reboot` commands.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `delay` | integer | `0` | Seconds before rebooting (0–3600) |
| `dryRun` | boolean | `false` | Preview without executing |

**Example prompt:** "Schedule a reboot of edge-01 in 5 minutes."

---

### `run_command` — Write · Destructive

Execute an arbitrary RouterOS console command via SSH. Protected by a configurable allow/deny policy. Output is capped at 4000 characters. Use dedicated tools (`reboot`, etc.) for controlled operations — prefer this only for gaps in tool coverage.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `command` | string | — | RouterOS console command |
| `dryRun` | boolean | `false` | Validate allow/deny policy without executing |

**Allow/deny policy:** Per-router `cmdAllow`/`cmdDeny` lists in `routers.yaml` take precedence; `MIKROMCP_CMD_ALLOW` / `MIKROMCP_CMD_DENY` env vars apply globally. Built-in deny list blocks `/system reboot*` and other destructive commands.

**Requires `ssh` policy** on the RouterOS user group.

**Example prompt:** "Run `/ip route print detail` on core-01."

---

## Packages

### `list_packages` — Read

List installed RouterOS packages with version and enabled status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by exact package name |

**Example prompt:** "Which packages are installed on core-01 and are any disabled?"

---

### `manage_package` — Write · Idempotent

Enable or disable a RouterOS package. Changes take effect only after a router reboot — use `reboot` to apply. No-op if already in the target state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `enable` \| `disable` | — | Operation to perform |
| `name` | string | — | Package name |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Disable the `ipv6` package on edge-01, then reboot."

---

## Upgrade

### `get_upgrade_status` — Read

Check available RouterOS/firmware upgrades, current channel, and routerboard firmware versions.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |

**Example prompt:** "Is there a RouterOS upgrade available for router core-sw?"

---

### `manage_upgrade` — Destructive

Trigger a RouterOS package update check or start an upgrade installation. The `install` action causes a router reboot.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `action` | enum | — | `check` (non-destructive) or `install` (destructive, reboots) |
| `dryRun` | boolean | false | Preview without executing |

**Example prompt:** "Check for RouterOS upgrades on router border-r1, then install if a newer version is available"

---

## Backup & Config Export

### `create_backup` — Write

Create a binary RouterOS configuration backup file on the router filesystem. Optionally encrypt with a password.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `name` | string | `backup` | Backup file name (without .backup extension) |
| `password` | string | — | Optional encryption password |
| `dryRun` | boolean | false | Preview without creating |

**Example prompt:** "Create an encrypted backup named 'pre-upgrade' on router home-gw"

---

### `export_config` — Read

Export the running RouterOS configuration as a RouterOS script (equivalent to `/export`). Returns the full config text inline, or saves to a router file.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `compact` | boolean | false | Export only non-default settings |
| `file` | string | — | Save to a router file instead of returning inline (filename without extension) |

**Example prompt:** "Export the full running config from router core-sw as a script"

---

## Scripts

### `list_scripts` — Read

List RouterOS scripts with optional name filter.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by script name (substring match) |

**Example prompt:** "List all scripts on core-01 that have 'backup' in the name."

---

### `manage_script` — Write · Idempotent

Add, update, or remove a RouterOS script. `add` throws `CONFLICT` if a script with the same name already exists; `update` throws `NOT_FOUND` if it does not.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `update` \| `remove` | — | Operation to perform |
| `name` | string | — | Script name (idempotency key) |
| `source` | string | — | Script body (required for `add` and `update`) |
| `comment` | string | — | Optional comment |
| `dontRequirePermissions` | boolean | — | Allow script to run without elevated permissions |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create a script named 'daily-log-clear' on core-01 that clears the system log."

---

### `run_script` — Write

Execute a named RouterOS script. Fire-and-forget — the script runs asynchronously and output is written to the router system log. Use `get_log` after calling this tool to see results.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Name of the script to execute |

**Example prompt:** "Run the 'daily-log-clear' script on core-01 and show me the resulting log entries."

---

## Scheduler

### `list_scheduled_jobs` — Read

List RouterOS scheduler entries with next-run time, interval, and disabled state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by exact job name |

**Example prompt:** "Show all scheduled jobs on core-01."

---

### `manage_scheduled_job` — Write · Idempotent

Add, update, remove, enable, or disable a RouterOS scheduler entry. `add` throws `CONFLICT` if the name already exists; `update` throws `NOT_FOUND` if it does not.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `update` \| `remove` \| `enable` \| `disable` | — | Operation to perform |
| `name` | string | — | Job name (idempotency key) |
| `onEvent` | string | — | Script name or inline command to run (required on `add`) |
| `startDate` | string | — | Start date (e.g. `jan/01/2000`) |
| `startTime` | string | — | Start time (e.g. `00:00:00`) |
| `interval` | string | — | Run interval (e.g. `00:05:00` for every 5 minutes) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Schedule the 'daily-log-clear' script to run every day at 03:00 on core-01."

---

## Files

### `list_files` — Read

List files on a MikroTik router filesystem. Supports filtering by name and type.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by file name (substring match) |
| `type` | string | — | Filter by file type (e.g. `script`, `backup`, `package`) |

**Example prompt:** "List all backup files on core-01."

---

### `get_file_content` — Read

Read a text file's contents from a MikroTik router. Only suitable for text files — binary files will return garbled content.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Exact file name on the router (e.g. `flash/script.rsc`) |

**Example prompt:** "Show me the contents of flash/my-script.rsc on core-01."

---

### `upload_file` — Write

Upload a text file to a MikroTik router over FTP. Overwrites if the file already exists.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Target filename on the router (e.g. `flash/my-script.rsc`) |
| `content` | string | — | File content to upload (text only) |
| `dryRun` | boolean | `false` | Validate FTP connectivity without writing the file |

**Requires `ftp` policy** on the RouterOS user group.

**Example prompt:** "Upload this RouterOS script to core-01 as flash/my-script.rsc."

---

## Containers

### `list_containers` — Read

List RouterOS containers with image, status, and resource usage.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "List all containers running on core-01."

---

### `manage_container` — Write · Idempotent

Create, start, stop, or remove a RouterOS container. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `create` \| `start` \| `stop` \| `remove` | — | Operation to perform |
| `name` | string | — | Container name (idempotency key) |
| `image` | string | — | Container image (required for `create`, e.g. `nginx:latest`) |
| `interface` | string | — | Container network interface (required for `create`) |
| `envs` | string | — | Environment variables as RouterOS-format string |
| `mounts` | string | — | Volume mounts as RouterOS-format string |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Stop the container named 'mon-agent' on core-01."

---

## Interfaces

### `list_interfaces` — Read

List network interfaces with optional filtering and pagination.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `type` | string | — | Filter by interface type (e.g. `ether`, `vlan`, `bridge`) |
| `running` | boolean | — | If `true`, return only running/up interfaces |
| `macAddress` | string | — | Filter by exact MAC address |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show me all running interfaces on core-01."

---

### `manage_vlan` — Write · Idempotent

Add, remove, enable, or disable a VLAN sub-interface. Idempotent by `name`. `add` returns `already_exists` when the interface already exists with matching config; throws `CONFLICT` if it exists with different config.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `enable` \| `disable` | — | Operation to perform |
| `name` | string | — | Interface name (e.g. `vlan100`) |
| `vlanId` | integer | — | VLAN ID (1–4094); required for `add` |
| `parentInterface` | string | — | Parent interface (e.g. `ether1`); required for `add` |
| `mtu` | `number` | `1500` | MTU size (68–9000; applies on add only) |
| `disabled` | `boolean` | `false` | Create the VLAN in disabled state (add only) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create VLAN 100 on ether1 of core-01 named vlan100, then disable it for maintenance."

---

## Bridge

### `list_bridges` — Read

List bridge interfaces and their port members.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List all bridges on core-01 and show which ports are members."

---

### `manage_bridge` — Write · Idempotent

Create or remove a bridge interface. Returns `already_exists` if the bridge already exists.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `create` \| `remove` | — | Operation to perform |
| `name` | string | — | Bridge interface name (alphanumeric, `-`, `_`; max 15 chars) |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Create the bridge in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create a bridge interface named bridge1 on core-01."

---

### `manage_bridge_port` — Write · Idempotent

Add or remove an interface as a bridge port. Returns `already_exists` if the interface is already a member.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `bridge` | string | — | Bridge interface name |
| `interface` | string | — | Interface to add or remove |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add ether2 and ether3 to bridge1 on core-01."

---

## WiFi / Wireless

> Path is version-aware: `/interface/wifi` on RouterOS 7.13+, `/interface/wireless` on older versions.

### `list_wifi_interfaces` — Read

List WiFi/wireless interfaces with SSID and enabled/disabled status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show me all WiFi interfaces on edge-01."

---

### `list_wifi_clients` — Read

List currently connected WiFi stations with signal strength and transfer rates.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by WiFi interface name |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "How many clients are connected to wlan1 on edge-01 and what's their signal strength?"

---

### `manage_wifi_interface` — Write · Idempotent

Enable, disable, or change SSID on a WiFi interface. Returns `no_change` if already in the requested state. At least one of `disabled` or `ssid` must be provided.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | WiFi interface name (e.g. `wifi1`, `wlan1`) |
| `disabled` | boolean | — | `true` to disable, `false` to enable |
| `ssid` | string | — | New SSID to set (max 32 chars) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Disable the wifi1 interface on edge-01."

---

## WireGuard

### `list_wireguard_interfaces` — Read

List WireGuard interfaces and their listen port and running state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List WireGuard interfaces on core-01."

---

### `list_wireguard_peers` — Read

List WireGuard peers with last handshake time and transfer statistics.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by WireGuard interface name |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all WireGuard peers on wg0 of core-01 and when they last connected."

---

### `manage_wireguard_peer` — Write · Idempotent

Add or remove a WireGuard peer. Idempotent by public key: `add` returns `already_exists` if a peer with the same public key already exists on the interface.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `interface` | string | — | WireGuard interface name (e.g. `wg0`) |
| `publicKey` | string | — | Peer public key in base64 format (44 chars) |
| `allowedAddress` | string | — | Allowed IP/CIDR for this peer (e.g. `10.0.0.2/32`) |
| `endpoint` | string | — | Peer endpoint as `IP:port` (e.g. `1.2.3.4:51820`) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a WireGuard peer with public key ABC123... on wg0 of core-01, allowed address 10.8.0.5/32."

---

## IP Addresses

### `manage_ip_address` — Write · Idempotent

Add, update, or remove an IP address on an interface.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `update` | — | Operation to perform |
| `address` | string | — | IP address in CIDR notation (e.g. `192.168.1.1/24`) |
| `interface` | string | — | Interface name |
| `network` | string | — | Network address (auto-calculated if omitted) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add 10.0.0.1/24 to ether2 on core-01."

---

## DNS

### `list_dns_entries` — Read

List static DNS entries with optional filtering by hostname and record type.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by hostname (partial match) |
| `type` | `A` \| `CNAME` \| `TXT` \| `all` | `all` | Filter by record type |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List all static DNS A records on core-01."

---

### `manage_dns_entry` — Write · Idempotent

Add or remove a static DNS entry. Idempotent by name+type.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `name` | string | — | Hostname for the DNS record (e.g. `server.example.com`) |
| `type` | `A` \| `CNAME` \| `TXT` | `A` | DNS record type |
| `address` | string | — | IP address — required for A records |
| `cname` | string | — | Target hostname — required for CNAME records |
| `text` | string | — | Text value — required for TXT records |
| `ttl` | string | — | TTL value (e.g. `1d`, `00:05:00`) |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Create the entry in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a static DNS A record for printer.lan pointing to 192.168.1.50 on core-01."

---

### `get_dns_settings` — Read

Read DNS resolver configuration: upstream servers, cache size, cache TTL, and whether remote DNS requests are allowed.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "What DNS servers is core-01 using and is it allowing remote DNS requests?"

---

## DHCP

### `list_dhcp_leases` — Read

List DHCP leases with optional filtering.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `server` | string | — | Filter by DHCP server name |
| `status` | `bound` \| `waiting` \| `offered` | — | Filter by lease status |
| `macAddress` | string | — | Filter by client MAC address |
| `leaseType` | `dynamic` \| `static` \| `all` | `all` | Filter by lease type |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all static DHCP leases on edge-01."

---

### `list_dhcp_servers` — Read

List DHCP server instances with their interface, address pool, and enabled status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all DHCP servers on core-01."

---

### `manage_dhcp_server` — Write · Idempotent

Add, remove, enable, or disable a DHCP server instance. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `update` | — | Operation to perform |
| `name` | string | — | Server name (idempotency key) |
| `interface` | string | — | Interface the server listens on |
| `addressPool` | string | — | Address pool name |
| `leaseTime` | string | — | Lease duration (e.g. `1d`, `00:10:00`) |
| `disabled` | boolean | `false` | Create the server in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a DHCP server on ether2 of core-01 using pool lan-pool."

---

### `list_ip_pools` — Read

List IP address pools and their ranges. Pools serve any subsystem (DHCP, PPP, hotspot), not only DHCP servers.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all IP pools on core-01."

---

### `manage_ip_pool` — Write · Idempotent

Add or remove an IP address pool. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `name` | string | — | Pool name (idempotency key) |
| `ranges` | string | — | IP range(s) (e.g. `192.168.1.100-192.168.1.200`) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create an IP pool named lan-pool with range 192.168.1.100–192.168.1.200 on core-01."

---

### `manage_dhcp_lease` — Write · Idempotent

Convert a dynamic DHCP lease to static or remove a lease. Idempotent by MAC address — `make-static` is a no-op when the lease is already static.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `make-static` \| `remove` | — | Operation to perform |
| `macAddress` | string | — | Client MAC address (idempotency key) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Make the DHCP lease for MAC aa:bb:cc:dd:ee:ff static on edge-01."

---

### `list_dhcp_clients` — Read

List DHCP client configurations — which interfaces obtain their IP address via DHCP.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by interface name |
| `status` | `enum` | `"all"` | Filter by status: `bound`, `searching`, `requesting`, `init`, `all` |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Which interfaces on edge-01 are configured as DHCP clients?"

---

### `manage_dhcp_client` — Write · Idempotent

Add, remove, enable, or disable a DHCP client on an interface. Idempotent by `interface`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `enable` \| `disable` | — | Operation to perform |
| `interface` | string | — | Interface name (idempotency key) |
| `usePeerDns` | `boolean` | `true` | Use DNS servers advertised by DHCP server (add only) |
| `usePeerNtp` | `boolean` | `false` | Use NTP servers advertised by DHCP server (add only) |
| `addDefaultRoute` | `boolean` | `true` | Install default route from DHCP offer (add only) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a DHCP client on ether1 of edge-01 to obtain an IP from the upstream provider."

---

## IP Services

### `list_ip_services` — Read

List RouterOS IP services with their port, enabled/disabled status, and allowed address restrictions.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | `enum` | — | Filter to a specific service (api, api-ssl, ssh, telnet, www, www-ssl, winbox, ftp) |
| `enabled` | `boolean` | — | When `true`, return only enabled services; when `false`, only disabled |

**Example prompt:** "Show me which IP services are enabled on core-01 and what ports they use."

---

### `manage_ip_service` — Write · Idempotent

Enable or disable a RouterOS IP service. Port changes are intentionally excluded to prevent accidental lockout. Returns `no_change` when the service is already in the requested state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `enable` \| `disable` | — | Operation to perform |
| `name` | `api` \| `api-ssl` \| `ssh` \| `telnet` \| `www` \| `www-ssl` \| `winbox` \| `ftp` | — | Service name to manage |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Disable telnet and FTP on core-01 — only SSH and API-SSL should be allowed."

---

## PPPoE & OpenVPN

### `list_pppoe_clients` — Read

List PPPoE client interfaces on a MikroTik router with connection state, assigned IP, and uptime. Supports filtering by parent interface and status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by parent interface name (exact match) |
| `status` | enum | `all` | `connected`, `disconnected`, or `all` |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List all connected PPPoE clients on core-router"

---

### `manage_pppoe_client` — Write · Idempotent

Add, update, or remove a PPPoE client interface. Idempotent by name: add returns `already_exists` when the same name, interface, and user already exist. Update returns `no_change` when all specified fields already match. Password is always written when provided (RouterOS does not expose it in GET).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | enum | — | `add`, `update`, or `remove` |
| `name` | string | — | PPPoE interface name — idempotency key |
| `interface` | string | — | Parent interface, e.g. `ether1` (required for add) |
| `user` | string | — | PPPoE username (required for add) |
| `password` | string | — | PPPoE password (write-only) |
| `serviceName` | string | — | PPPoE service name filter |
| `addDefaultRoute` | boolean | — | Install default route via this connection |
| `dialOnDemand` | boolean | — | Connect only when traffic is present |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a PPPoE client named pppoe-wan on ether1 with username myisp and password secret123"

---

### `list_ovpn_clients` — Read

List OpenVPN client interfaces on a MikroTik router with connection state and remote endpoint. Supports pagination.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Max results (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List OpenVPN clients on branch-router"

---

### `manage_ovpn_client` — Write · Idempotent

Add, update, or remove an OpenVPN client interface. Idempotent by name: add returns `already_exists` when the same name and `connectTo` already exist. Update returns `no_change` when all specified fields already match. Password is always written when provided.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | enum | — | `add`, `update`, or `remove` |
| `name` | string | — | OpenVPN interface name — idempotency key |
| `connectTo` | string | — | Remote server address (required for add) |
| `port` | integer | `1194` | Remote port |
| `mode` | enum | — | `ip` or `ethernet` |
| `protocol` | enum | — | `tcp-client` or `udp` |
| `certificate` | string | — | Certificate name from certificate store |
| `user` | string | — | OpenVPN username |
| `password` | string | — | OpenVPN password (write-only) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add an OpenVPN client named ovpn-hq connecting to 203.0.113.10 using certificate hq-cert"

---

### `get_ovpn_server` — Read

Read the OpenVPN server configuration from a MikroTik router, including enabled state, port, protocol, cipher, auth, and certificate.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "Show the OpenVPN server configuration on core-router"

---

### `manage_ovpn_server` — Write · Destructive · Idempotent

Enable or disable the OpenVPN server, or update its configuration. Enable/disable are idempotent — returns `no_change` when already in the desired state. The `set` action returns `no_change` when all specified fields already match.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | enum | — | `enable`, `disable`, or `set` |
| `port` | integer | — | Listening port (set only) |
| `mode` | enum | — | `ip` or `ethernet` (set only) |
| `protocol` | enum | — | `tcp-server` or `udp` (set only) |
| `certificate` | string | — | Server certificate name (set only) |
| `cipher` | enum | — | `blowfish128`, `aes128-cbc`, `aes192-cbc`, `aes256-cbc`, `aes128-gcm`, `aes256-gcm`, or `none` (set only) |
| `auth` | enum | — | `md5`, `sha1`, `sha256`, `sha512`, or `null` (set only) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Enable the OpenVPN server on core-router and set the certificate to server-cert"

---

## Routing

### `list_routes` — Read

List the routing table with optional filtering.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `activeOnly` | boolean | `false` | Only return active routes |
| `staticOnly` | boolean | `false` | Only return static routes |
| `routingTable` | string | — | Filter by routing table name |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show me the active routes on core-01."

---

### `manage_route` — Write · Idempotent

Add or remove a static route. Plain IP addresses without a prefix are auto-converted to `/32`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `dstAddress` | string | — | Destination network in CIDR (e.g. `10.0.0.0/8`); plain IP becomes `/32` |
| `gateway` | string | — | Next-hop gateway IP |
| `routingTable` | string | `main` | Routing table name |
| `distance` | integer | `1` | Administrative distance |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a static route for 10.10.0.0/16 via 192.168.1.254 on core-01."

---

## Policy Routing

### `list_routing_rules` — Read

List policy routing rules in evaluation order. Supports filtering by table and disabled state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `table` | string | — | Filter by routing table name |
| `disabled` | boolean | — | Filter by disabled state |

**Example prompt:** "Show all policy routing rules on core-01."

---

### `manage_routing_rule` — Write · Idempotent

Add, remove, enable, or disable a policy routing rule. Idempotent by the composite key `srcAddress + dstAddress + interface + table`. At least one of `srcAddress`, `dstAddress`, or `interface` is required on `add`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `enable` \| `disable` | — | Operation to perform |
| `table` | string | — | Routing table name (required for all actions) |
| `srcAddress` | string | — | Source CIDR to match |
| `dstAddress` | string | — | Destination CIDR to match |
| `interface` | string | — | Incoming interface to match |
| `priority` | integer | — | Rule priority (0–4294967295) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a policy routing rule that sends traffic from 10.10.0.0/24 to the 'vpn' routing table on core-01."

---

### `list_routing_tables` — Read

List custom routing tables.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "What custom routing tables are defined on core-01?"

---

### `manage_routing_table` — Write · Idempotent

Create or remove a custom routing table. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `name` | string | — | Routing table name (idempotency key) |
| `fib` | boolean | `false` | Whether to sync this table with the FIB |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create a routing table named 'vpn' on core-01."

---

## Routing Protocols (read-only)

### `list_bgp_peers` — Read

List BGP sessions with state, remote AS, prefix counts, and uptime. RouterOS 7+ only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `state` | string | — | Filter by session state (e.g. `established`, `active`, `idle`) |

**Example prompt:** "Show all BGP sessions on core-01 — are any not established?"

---

### `list_ospf_neighbors` — Read

List OSPF neighbors with state, interface, DR/BDR, and uptime. RouterOS 7+ only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `state` | string | — | Filter by neighbor state (e.g. `full`, `2-way`, `init`) |

**Example prompt:** "Show OSPF neighbors on core-01 — any stuck in 2-way state?"

---

## Firewall

### `list_firewall_rules` — Read

List firewall rules in evaluation order.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `table` | `filter` \| `nat` \| `mangle` | `filter` | Firewall table |
| `chain` | string | — | Filter by chain name |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show me all forward chain rules on core-01."

---

### `manage_firewall_rule` — Write · Idempotent

Add, remove, disable, or enable a firewall rule. Uses `comment` as the idempotency key. Throws `CONFLICT` if a rule with the same comment exists but with different port or interface config.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `disable` \| `enable` | — | Operation to perform |
| `table` | `filter` \| `nat` | `filter` | Firewall table |
| `chain` | string | — | Chain name (e.g. `input`, `forward`, `output`, `srcnat`) |
| `comment` | string | — | **Idempotency key** — required for all actions |
| `ruleAction` | string | — | RouterOS action (e.g. `accept`, `drop`, `masquerade`) |
| `srcAddress` | string | — | Source IP or CIDR |
| `dstAddress` | string | — | Destination IP or CIDR |
| `srcPort` | string | — | Source port or range (e.g. `80`, `8000-9000`) |
| `dstPort` | string | — | Destination port or range |
| `protocol` | string | — | Protocol (`tcp`, `udp`, `icmp`, etc.) |
| `inInterface` | string | — | Incoming interface |
| `outInterface` | string | — | Outgoing interface |
| `position` | integer | — | Rule position (0-based); appended if omitted |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a drop rule for 1.2.3.4 on the input chain of core-01, comment it 'block-attacker'."

---

## Mangle Rules

### `list_mangle_rules` — Read

List firewall mangle rules in evaluation order. Supports filtering by chain, action, and disabled state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `chain` | string | — | Filter by chain (e.g. `prerouting`, `forward`, `postrouting`) |
| `action` | string | — | Filter by mangle action (e.g. `mark-routing`, `mark-connection`) |
| `disabled` | boolean | — | Filter by disabled state |

**Example prompt:** "Show all mangle rules that set a routing mark on core-01."

---

### `manage_mangle_rule` — Write · Idempotent

Add, remove, enable, or disable a mangle rule. Uses `comment` as the idempotency key. Throws `CONFLICT` if a rule with the same comment exists but with different chain or match config.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `enable` \| `disable` | — | Operation to perform |
| `comment` | string | — | **Idempotency key** — required for all actions |
| `chain` | string | — | Mangle chain (required on `add`): `prerouting`, `input`, `forward`, `output`, `postrouting` |
| `srcAddress` | string | — | Source IP/CIDR to match |
| `dstAddress` | string | — | Destination IP/CIDR to match |
| `srcAddressList` | string | — | Source address list name to match |
| `dstAddressList` | string | — | Destination address list name to match |
| `protocol` | string | — | Protocol to match (e.g. `tcp`, `udp`) |
| `srcPort` | string | — | Source port or range |
| `dstPort` | string | — | Destination port or range |
| `inInterface` | string | — | Incoming interface to match |
| `outInterface` | string | — | Outgoing interface to match |
| `newRoutingMark` | string | — | Routing mark to set |
| `newConnectionMark` | string | — | Connection mark to set |
| `newDscpValue` | integer | — | DSCP value to set (0–63) |
| `passthrough` | boolean | — | Whether to continue matching subsequent rules |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a mangle rule on core-01 that marks traffic from 10.10.0.0/24 with routing-mark 'vpn' in the prerouting chain."

---

## Address Lists

### `list_address_list_entries` — Read

List firewall address list entries. Supports filtering by list name and address.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `list` | string | — | Filter by address list name |
| `address` | string | — | Filter by address (IP or CIDR) |

**Example prompt:** "Show all entries in the 'blocked-ips' address list on core-01."

---

### `manage_address_list_entry` — Write · Idempotent

Add or remove a firewall address list entry. Idempotent by list name + address.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `list` | string | — | Address list name |
| `address` | string | — | IP address or CIDR to add/remove |
| `comment` | string | — | Optional comment |
| `timeout` | string | — | Expiry timeout (e.g. `1d`, `2h30m`) — omit for permanent |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add 203.0.113.5 to the 'blocked-ips' address list on core-01 with a 24-hour timeout."

---

## IPSec / VPN

### `list_ipsec_peers` — Read

List IPSec peer configurations with state and connection status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all IPSec peers on edge-01 and which ones are established."

---

### `list_ipsec_policies` — Read

List IPSec policy entries (traffic selectors).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List all IPSec policies on core-01."

---

### `manage_ipsec_peer` — Write · Idempotent

Add or remove an IPSec peer. Idempotent by `name`. Throws `CONFLICT` if the peer exists with different config.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` | — | Operation to perform |
| `name` | string | — | Peer name (idempotency key) |
| `address` | string | — | Remote peer IP address |
| `authMethod` | `pre-shared-key` \| `rsa-signature` | — | Authentication method |
| `secret` | string | — | Pre-shared key (required for `pre-shared-key`) |
| `profile` | string | — | IPSec profile name |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add an IPSec peer named vpn-branch on edge-01 to 203.0.113.5 with a pre-shared key."

---

## Certificates

### `list_certificates` — Read

List router certificates with validity, fingerprint, and usage flags.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "List all certificates on core-01 and show which ones are expiring soon."

---

### `manage_certificate` — Write · Idempotent

Trust, untrust, or remove a certificate. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `trust` \| `untrust` \| `remove` | — | Operation to perform |
| `name` | string | — | Certificate name (idempotency key) |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Remove the expired certificate named old-vpn-cert from edge-01."

---

## Users

### `list_users` — Read

List RouterOS user accounts with group membership and last-login info.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all users on core-01 and which groups they belong to."

---

### `manage_user` — Write · Idempotent

Add, remove, enable, disable, or change the password of a RouterOS user account. Idempotent by `name`.

> **Required permissions:** The RouterOS credential used by MikroMCP must belong to the `full` group. Accounts in `write` or lower groups will receive HTTP 500 "not enough permissions" from RouterOS when attempting any write operation on `/user`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `enable` \| `disable` \| `set-password` | — | Operation to perform |
| `name` | string | — | Username (idempotency key) |
| `group` | string | — | RouterOS group name (required for `add`; e.g. `read`, `write`, `full`) |
| `password` | string | — | Password (required for `add` and `set-password`) |
| `address` | string | — | Allowed source address or range |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a read-only user named monitor on core-01."

---

## User Groups

### `list_user_groups` — Read

List local user groups on a MikroTik router with their policy bitmask.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `limit` | number | 100 | Maximum groups to return (1–500) |

**Example prompt:** "List all user groups on router home-gw"

---

### `manage_user_group` — Write

Add, update, or remove a RouterOS user group. Idempotent by name. `update` changes the policy string; returns `no_change` if unchanged.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `action` | enum | — | `add`, `update`, or `remove` |
| `name` | string | — | Group name (idempotency key) |
| `policy` | string | — | Comma-separated policy list (e.g. `read,write,ftp`). Required for `add`. |
| `skin` | string | — | Winbox skin (optional) |
| `dryRun` | boolean | false | Preview without applying |

**Example prompt:** "Add a user group named 'ops' with read and write policies on router home-gw"

---

## Queues / QoS

### `list_queues` — Read

List simple queue entries with their targets, limits, and current rates.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all bandwidth queues on edge-01."

---

### `manage_queue` — Write · Idempotent

Add, update, or remove a simple queue entry. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `update` | — | Operation to perform |
| `name` | string | — | Queue name (idempotency key) |
| `target` | string | — | Target IP address or CIDR |
| `maxLimit` | string | — | Max rate as `upload/download` (e.g. `10M/10M`) |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Create or update the queue in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Limit the device at 192.168.1.50 to 10 Mbps on core-01."

---

## VRRP

### `list_vrrp_instances` — Read

List VRRP instances with their virtual IP, priority, and master/backup state.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show VRRP instances on core-01 and which is master."

---

### `manage_vrrp_instance` — Write · Idempotent

Add, update, or remove a VRRP instance. Idempotent by `name`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `update` | — | Operation to perform |
| `name` | string | — | VRRP interface name (idempotency key) |
| `interface` | string | — | Underlying interface |
| `vrid` | integer | — | Virtual Router ID (1–255) |
| `priority` | integer | — | VRRP priority (1–254; 255 reserved for master) |
| `address` | string | — | Virtual IP address |
| `disabled` | boolean | `false` | Create or update in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Check the VRRP priority on core-01 and increase it if it's not the master."

---

## SNMP & NTP

### `get_snmp_settings` — Read

Read SNMP configuration: enabled state, community strings, and contact/location info.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "Is SNMP enabled on core-01 and what community string is configured?"

---

### `get_ntp_settings` — Read

Read NTP client configuration: enabled state, primary and secondary server addresses.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "What NTP servers is edge-01 using?"

---

### `manage_ntp_client` — Write

Configure the RouterOS NTP client: enable/disable, set server addresses, mode, and optional VLAN source interface. Idempotent — no-op when values already match. Complements `get_ntp_settings`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `enabled` | boolean | — | Enable or disable the NTP client |
| `mode` | enum | — | `unicast`, `broadcast`, `multicast`, or `manycast` |
| `servers` | string | — | Comma-separated NTP server addresses or hostnames |
| `vlanInterface` | string | — | Source VLAN interface for NTP packets |
| `dryRun` | boolean | false | Preview without applying |

**Example prompt:** "Set the NTP servers to pool.ntp.org on router home-gw and enable the client"

---

## Netwatch

### `list_netwatch_entries` — Read

List Netwatch monitoring entries with their target hosts, probe intervals, and current status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show all Netwatch entries on core-01 and which hosts are currently down."

---

### `manage_netwatch_entry` — Write · Idempotent

Add, update, or remove a Netwatch monitoring entry. Idempotent by `host`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add` \| `remove` \| `update` | — | Operation to perform |
| `host` | string | — | Target IP address or hostname (idempotency key) |
| `interval` | string | — | Probe interval (e.g. `00:00:10`) |
| `upScript` | string | — | Script to run when host comes up |
| `downScript` | string | — | Script to run when host goes down |
| `comment` | string | — | Optional comment |
| `disabled` | boolean | `false` | Create or update in disabled state |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Add a Netwatch entry for 8.8.8.8 on core-01 with a 30-second probe interval."

---

## Discovery & ARP

### `list_neighbors` — Read

List LLDP/CDP/MNDP neighbor discovery entries. Shows neighbor hostname, interface, platform, and IP.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by local interface name |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "What neighbors can core-01 see via LLDP?"

---

### `list_arp_entries` — Read

List ARP table entries with IP address, MAC, interface, and status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Filter by interface name |
| `macAddress` | string | — | Filter by MAC address |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show the ARP table on edge-01 for the ether2 interface."

---

## Diagnostics

> **SSH policy required.** `ping`, `traceroute`, `torch`, and `run_command` connect via SSH because the RouterOS 7.x REST API returns a permission error for tool commands regardless of user policy. The RouterOS user must have the `ssh` policy in its group in addition to the standard policies.
>
> **`torch` also requires the `sniff` policy.** RouterOS enforces packet-capture permissions separately.

### `ping` — Read

Send ICMP echo requests from the router to a target. 100% packet loss is a valid result, not an error.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `address` | string | — | Target IP address or hostname |
| `count` | integer | `4` | Number of ICMP echo requests (1–20) |
| `size` | integer | `56` | Packet size in bytes (14–65535) |
| `routingTable` | string | — | Routing table to use for the ping |

**Example prompt:** "Ping 8.8.8.8 from core-01 with 10 packets."

---

### `traceroute` — Read

Trace the network path from the router to a destination. Timeouts and partial hops are valid results.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `address` | string | — | Target IP address or hostname |
| `count` | integer | `3` | Probes per hop (1–5) |
| `maxHops` | integer | `15` | Maximum number of hops (1–30) |

**Example prompt:** "Traceroute to 1.1.1.1 from edge-01."

---

### `torch` — Read

Capture a real-time traffic snapshot on an interface. The call blocks for `duration` seconds, then returns the top flows by bytes.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `interface` | string | — | Interface name (e.g. `ether1`, `bridge1`) |
| `duration` | integer | `5` | Capture duration in seconds (1–30) |
| `srcAddress` | string | — | Filter flows by source IP |
| `dstAddress` | string | — | Filter flows by destination IP |

**Requires `ssh` and `sniff` policies** on the RouterOS user group.

**Example prompt:** "Show me the top traffic flows on ether1 of core-01 for 10 seconds."

---

### `get_log` — Read

Read and filter the system log. Client-side filtering by topic, message prefix, and time window.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Maximum entries to return (1–500) |
| `offset` | integer | `0` | Pagination offset |
| `topics` | string[] | — | Include entries whose topics field contains any of these strings (e.g. `["firewall", "dhcp"]`) |
| `prefix` | string | — | Substring match against log message |
| `sinceMinutes` | integer | — | Only return entries from the last N minutes (1–1440) |

**Example prompt:** "Show me firewall log entries from the last 30 minutes on core-01."

---

## Log Rules & Actions

### `list_log_rules` — Read

List RouterOS system logging rules with topics, action target, and enabled status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `topics` | string | — | Filter by topics (substring match) |
| `logAction` | string | — | Filter by action name (exact match) |
| `limit` | number | 100 | Maximum rules to return (1–500) |

**Example prompt:** "Show all log rules that send to disk on router home-gw"

---

### `manage_log_rule` — Write

Add, remove, enable, or disable a RouterOS system logging rule. Idempotent by topics+action composite key.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `action` | enum | — | `add`, `remove`, `enable`, or `disable` |
| `topics` | string | — | Log topics (e.g. `firewall`, `system,!debug`) |
| `logAction` | string | — | Log action name to route to (e.g. `memory`, `disk`) |
| `prefix` | string | — | Optional log entry prefix |
| `dryRun` | boolean | false | Preview without applying |

**Example prompt:** "Add a log rule to send firewall topics to the remote syslog action on router edge-r1"

---

### `list_log_actions` — Read

List RouterOS log action targets (memory, disk, remote syslog, etc.).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `type` | enum | — | Filter by type: `memory`, `disk`, `remote`, `echo`, `email` |
| `limit` | number | 100 | Maximum actions to return (1–500) |

**Example prompt:** "List all remote syslog action targets on router home-gw"

---

### `manage_log_action` — Write

Add or remove a RouterOS log action target. Idempotent by name. `type` is required when adding.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router identifier |
| `action` | enum | — | `add` or `remove` |
| `name` | string | — | Action name (idempotency key) |
| `type` | enum | — | Action type (required for add): `memory`, `disk`, `remote`, `echo`, `email` |
| `remote` | string | — | Remote syslog server IP (for `type=remote`) |
| `remotePort` | number | — | Remote syslog UDP port (default 514) |
| `diskFileName` | string | — | Disk log file name (for `type=disk`) |
| `dryRun` | boolean | false | Preview without applying |

**Example prompt:** "Add a remote syslog action named 'central-syslog' pointing to 10.0.0.50 on router home-gw"

---

## Change Management

These tools work together as a workflow: `plan_changes` → `apply_plan` → `rollback_change` (if needed).

### `plan_changes` — Write (preview only)

Preview a sequence of write operations without applying them. Each step is run with `dryRun=true` against live router state, so the preview reflects actual current config. Use `apply_plan` to execute the same steps for real.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `steps` | object[] | — | Ordered list of operations to preview (1–10 steps) |
| `steps[].tool` | string | — | Name of the MikroMCP tool to invoke |
| `steps[].params` | object | — | Tool parameters (omit `routerId` and `dryRun` — injected automatically) |

**Example prompt:** "Plan these changes on core-01: add a firewall rule to drop 1.2.3.4, then add it to the blocked-ips address list."

---

### `apply_plan` — Write · Destructive

Execute a sequence of write operations in order. Takes a snapshot of affected RouterOS paths before applying, enabling rollback via `rollback_change`. Stops and reports on the first step that fails.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `steps` | object[] | — | Ordered list of operations to apply (1–10 steps) |
| `steps[].tool` | string | — | Name of the MikroMCP tool to invoke |
| `steps[].params` | object | — | Tool parameters (omit `routerId` — injected automatically) |
| `confirmationToken` | string | — | HMAC confirmation token (required in HTTP mode) |

**Example prompt:** "Apply the plan we just previewed on core-01."

---

### `rollback_change` — Write · Destructive

Restore the RouterOS section state captured before a previous `apply_plan` run. Uses the snapshot stored in the write journal.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `journalId` | string | — | Journal entry ID from `write-journal.ndjson` to roll back |
| `dryRun` | boolean | `false` | Preview the restore plan without applying changes |

**Example prompt:** "Roll back the last change on core-01 — something broke after the firewall update."

> **Diffing behaviour:** rollback identifies which records to update, create, or remove by matching snapshot records to current records using a per-RouterOS-path semantic key (e.g. `name` for most named resources, `host` for netwatch entries). For singleton settings resources without a natural identity field — notably `system/clock` — no semantic key is defined and rollback falls back to whole-record signature matching, which may reapply a changed record as a delete-then-create rather than an in-place update.

---

## Fleet Operations

### `check_router_health` — Read

Probe one or more routers for reachability, REST API availability, SSH availability, and RouterOS version. Returns a per-router health summary.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerIds` | string[] | — | List of router IDs to probe (use `tags` or `routerIds`, not both) |
| `tags` | string[] | — | Target all routers matching any of these tags |
| `checkSsh` | boolean | `false` | Also probe SSH connectivity |
| `concurrency` | integer | `5` | Maximum simultaneous probes (1–20) |

**Example prompt:** "Check the health of all routers tagged 'production' and flag any that are unreachable."

---

### `bulk_execute` — Write

Fan out any single-router tool call to multiple routers by ID or tag with configurable concurrency. Fleet tools cannot be used as the inner tool. Non-destructive tools fan out immediately. Destructive tools require a two-step confirmation flow (see below).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `toolName` | string | — | Name of the single-router tool to fan out |
| `routerIds` | string[] | — | List of router IDs to target (use `tags` or `routerIds`, not both) |
| `tags` | string[] | — | Target all routers with ALL of these tags (mutually exclusive with `routerIds`) |
| `params` | object | — | Parameters for the tool call (omit `routerId` — injected per router) |
| `concurrency` | integer | `5` | Maximum simultaneous calls (1–20) |
| `confirmationToken` | string | — | Fleet confirmation token from a prior `APPROVAL_REQUIRED` response. Required to fan out a destructive tool. |

#### Fanning out destructive tools (two-step confirmation)

Destructive tools (those with `destructiveHint: true`) require `MIKROMCP_CONFIRMATION_SECRET` to be configured on the server. The flow is:

1. Call `bulk_execute` with the desired `toolName`, `routerIds`/`tags`, and `params` — **without** `confirmationToken`. The server returns an `APPROVAL_REQUIRED` error containing a `confirmationToken` in its `details`.
2. Re-submit the **identical** call with `confirmationToken` set to the value from step 1. The tool fans out to all resolved routers.

Tokens expire after 5 minutes and are single-use. If the router set or params change between calls, the token is rejected.

**Example prompt (non-destructive):** "Run `list_interfaces` on all routers tagged 'branch' and summarize the results."

**Example prompt (destructive):** "Reboot all routers with tag 'maintenance-window'. First call `bulk_execute` with `toolName: reboot` to get a confirmation token, then re-submit with that token."

---

## DNS Settings

### `manage_dns_settings` — Write · Idempotent

Update DNS resolver settings. Idempotent — returns `no_change` if nothing differs.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `servers` | string | — | Comma-separated upstream DNS server IPs |
| `allowRemoteRequests` | bool | — | Allow router to answer DNS queries from the network |
| `maxUdpPacketSize` | int (512–65535) | — | Maximum UDP packet size in bytes |
| `cacheMaxTtl` | string | — | Maximum cache TTL (e.g. `1d`) |
| `cacheSize` | int | — | DNS cache size in KiB |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Set the DNS servers on router home-gw to 1.1.1.1 and 8.8.8.8"

---

## Files

### `delete_file` — Write

Delete a file from the router filesystem by name. Idempotent — returns `not_found` gracefully if the file does not exist.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Exact file name (e.g. `flash/backup.backup`) |
| `dryRun` | boolean | `false` | Preview deletion without removing |

**Example prompt:** "Delete flash/old-backup.backup from router branch-1"

---

## IPSec Policies

### `manage_ipsec_policy` — Write · Idempotent

Add, remove, enable, or disable an IPSec policy. Idempotent by composite key `srcAddress`+`dstAddress`+`tunnel`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove`\|`enable`\|`disable` | — | Action to perform |
| `srcAddress` | string | — | Source CIDR |
| `dstAddress` | string | — | Destination CIDR |
| `tunnel` | bool | `false` | Tunnel mode (part of idempotency key) |
| `ipsecAction` | `encrypt`\|`discard`\|`none` | — | IPSec action (required for add) |
| `level` | `require`\|`use`\|`unique` | `require` | SA level |
| `saSourceAddress` | string | — | SA source IP for tunnel mode |
| `saDstAddress` | string | — | SA destination IP for tunnel mode |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Add an IPSec encrypt policy from 10.0.0.0/24 to 192.168.1.0/24 in tunnel mode on router vpn-hub"

---

## WireGuard Interfaces

### `manage_wireguard_interface` — Write · Idempotent

Add, remove, enable, or disable a WireGuard interface. Idempotent by name. RouterOS generates the private key on create — it is never passed in. The public key is returned after creation.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove`\|`enable`\|`disable` | — | Action to perform |
| `name` | string | — | Interface name (idempotency key) |
| `listenPort` | int (1–65535) | — | UDP listen port (RouterOS picks one if omitted) |
| `mtu` | int (1280–65535) | `1420` | MTU |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Create a new WireGuard interface named wg1 listening on port 51821 on router vpn-hub"

---

## Container Configuration

### `get_container_config` — Read

Read global container configuration: registry URL, RAM high-water mark, and veth interface name.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |

**Example prompt:** "Show me the container configuration on router core"

---

### `manage_container_config` — Write · Idempotent

Update global container settings (registry URL, RAM high-water mark, veth interface). Idempotent — returns `no_change` if nothing differs.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `registryUrl` | string | — | Container registry URL |
| `ramHighMb` | int | — | RAM high-water mark in MB |
| `vethInterface` | string | — | Veth interface name |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Set the container registry to https://my.registry.io on router core"

---

### `list_container_envs` — Read

List container environment variable entries, optionally filtered by container name.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by container name (exact match) |
| `limit` | int (1–500) | `100` | Maximum entries to return |

**Example prompt:** "List all environment variables for container my-app on router core"

---

### `manage_container_env` — Write · Idempotent

Add or remove a container environment variable. Idempotent by `name`+`key`. `add` returns `already_exists` if the entry matches; throws `CONFLICT` if the key exists with a different value.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove` | — | Action to perform |
| `name` | string | — | Container name |
| `key` | string | — | Environment variable name |
| `value` | string | — | Environment variable value (required for add) |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Add environment variable DEBUG=true to container my-app on router core"

---

### `list_container_mounts` — Read

List container volume mount definitions with source path, destination path, and mount name.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by mount name (exact match) |
| `limit` | int (1–500) | `100` | Maximum entries to return |

**Example prompt:** "Show me all container mounts on router core"

---

### `manage_container_mount` — Write · Idempotent

Add or remove a container volume mount. Idempotent by `name`. `add` returns `already_exists` if mount exists with matching paths; throws `CONFLICT` if name exists with different paths.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove` | — | Action to perform |
| `name` | string | — | Mount name (idempotency key) |
| `src` | string | — | Host source path (required for add) |
| `dst` | string | — | Container destination path (required for add) |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Add a mount named app-data mapping /mnt/data to /data for containers on router core"

---

## Network Diagnostics

### `bandwidth_test` — Read

Run a RouterOS bandwidth test from the router to a remote host running a RouterOS btest server. Returns TX/RX throughput in Mbps.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `address` | string | — | Remote host running RouterOS btest server |
| `protocol` | `tcp`\|`udp` | `tcp` | Test protocol |
| `direction` | `send`\|`receive`\|`both` | `both` | Test direction |
| `duration` | int (1–30) | `5` | Test duration in seconds |

**Example prompt:** "Run a bandwidth test from router home-gw to 192.168.99.2 for 10 seconds"

---

### `fetch_url` — Read

Send an HTTP/HTTPS GET or POST request from the router. Response body returned inline (capped at 64 KB). Use `outputFile` to save to the router filesystem instead.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `url` | string | — | URL to fetch |
| `method` | `GET`\|`POST` | `GET` | HTTP method |
| `httpData` | string | — | Request body for POST |
| `outputFile` | string | — | Router file path to save response instead of returning inline |

**Example prompt:** "Fetch http://10.0.0.1/status from router core-sw and show me the response body"

---

### `list_connections` — Read

List active connection tracking entries from the router firewall table. Filters applied client-side.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `srcAddress` | string | — | Substring match on source address |
| `dstAddress` | string | — | Substring match on destination address |
| `protocol` | string | — | Exact match (e.g. `tcp`, `udp`) |
| `limit` | int (1–500) | `100` | Maximum connections to return |

**Example prompt:** "Show me all active TCP connections from 192.168.1.0/24 on router edge"

---

## Interface Lists

### `list_interface_lists` — Read

List all interface lists defined on the router.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | int (1–500) | `100` | Maximum lists to return |

**Example prompt:** "List all interface lists on router core"

---

### `manage_interface_list` — Write · Idempotent

Add or remove an interface list. Idempotent by name. Removing a list that has members is blocked by RouterOS.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove` | — | Action to perform |
| `name` | string | — | Interface list name (idempotency key) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Create an interface list named WAN on router edge"

---

### `manage_interface_list_member` — Write · Idempotent

Add or remove an interface from an interface list. Idempotent by `list`+`interface` composite key.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`remove` | — | Action to perform |
| `list` | string | — | Interface list name |
| `interface` | string | — | Interface name to add/remove |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Add ether1 to the WAN interface list on router edge"

---

## PPP Profiles

### `list_ppp_profiles` — Read

List PPP profiles including the built-in `default` and `default-encryption` profiles.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Filter by profile name (exact match) |
| `limit` | int (1–500) | `100` | Maximum profiles to return |

**Example prompt:** "Show me all PPP profiles on router isp-edge"

---

### `manage_ppp_profile` — Write · Idempotent

Add, update, or remove a PPP profile. Idempotent by name. `update` returns `no_change` when values already match. Built-in profiles cannot be removed.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `action` | `add`\|`update`\|`remove` | — | Action to perform |
| `name` | string | — | Profile name (idempotency key) |
| `localAddress` | string | — | Local IP for router end of PPP link |
| `remoteAddress` | string | — | IP or pool name assigned to client |
| `dnsServer` | string | — | DNS server IP pushed to client |
| `rateLimit` | string | — | Rate limit string (e.g. `10M/10M`) |
| `sessionTimeout` | string | — | Session timeout (e.g. `1h`) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview changes without applying |

**Example prompt:** "Create a PPP profile named broadband with rate limit 10M/10M and session timeout 24h on router isp-edge"

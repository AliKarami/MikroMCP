# Available Tools

All 17 tools exposed by MikroMCP. Every tool requires a `routerId` parameter (string) that matches an entry in your `config/routers.yaml`.

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

**Example prompt:** "Run `/ip route print detail` on core-01."

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

### `create_vlan` — Write · Idempotent

Create a VLAN sub-interface. Returns `already_exists` if a VLAN with the same ID on the same parent already exists with matching config. Throws `CONFLICT` if it exists with different config.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `name` | string | — | Interface name (e.g. `vlan100`) |
| `vlanId` | integer | — | VLAN ID (1–4094) |
| `interface` | string | — | Parent interface (e.g. `ether1`) |
| `comment` | string | — | Optional comment |
| `dryRun` | boolean | `false` | Preview without applying |

**Example prompt:** "Create VLAN 100 on ether1 of core-01 named vlan100."

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

## DHCP

### `list_dhcp_leases` — Read

List DHCP leases with optional filtering.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `server` | string | — | Filter by DHCP server name |
| `status` | `bound` \| `waiting` \| `offered` | — | Filter by lease status |
| `macAddress` | string | — | Filter by client MAC address |
| `limit` | integer | `100` | Results per page (1–500) |
| `offset` | integer | `0` | Pagination offset |

**Example prompt:** "Show active DHCP leases on edge-01, filtered to MAC aa:bb:cc:dd:ee:ff."

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

Add, remove, disable, or enable a firewall rule. Uses `comment` as the idempotency key — rules with the same comment are treated as the same rule. Throws `CONFLICT` if a rule with the same comment exists but with different port or interface config.

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

## Diagnostics

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

**Example prompt:** "Show me the top traffic flows on ether1 of core-01 for 10 seconds."

---

### `get_log` — Read

Read and filter the system log. Client-side filtering by topic, message prefix, and time window. Entries with unparseable timestamps are included conservatively.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `routerId` | string | — | Target router |
| `limit` | integer | `100` | Maximum entries to return (1–500) |
| `offset` | integer | `0` | Pagination offset |
| `topics` | string[] | — | Include entries whose topics field contains any of these strings (e.g. `["firewall", "dhcp"]`) |
| `prefix` | string | — | Substring match against log message |
| `sinceMinutes` | integer | — | Only return entries from the last N minutes (1–1440) |

**Example prompt:** "Show me firewall log entries from the last 30 minutes on core-01."

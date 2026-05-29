# RouterOS documentation pointers

**Rule:** For RouterOS field semantics, defaults, valid values, or version
differences, FETCH the linked official page — do not guess. These are pointers,
not copies. MikroMCP tool behavior is the source of truth for *how* to act; the
official docs are the source of truth for *what a setting means*.

If a deep link 404s, start from the RouterOS space root and search:
- RouterOS space: https://help.mikrotik.com/docs/spaces/ROS/pages/328059/RouterOS
- REST API guide: https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API

## Family → official doc → REST path

| Family | Official doc (help.mikrotik.com) | REST path |
|---|---|---|
| REST API basics | https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API | `/rest` |
| Users & groups | https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User | `user`, `user/group` |
| Firewall | search "Firewall" in the ROS space | `ip/firewall/*` |
| Routing | search "Routing" in the ROS space | `ip/route`, `routing/*` |
| DHCP | search "DHCP" in the ROS space | `ip/dhcp-server/*`, `ip/dhcp-client` |
| DNS | search "DNS" in the ROS space | `ip/dns`, `ip/dns/static` |
| WireGuard | search "WireGuard" in the ROS space | `interface/wireguard*` |
| Wireless / WiFi | search "WiFi" in the ROS space | `interface/wifi` or `interface/wireless` |
| IPSec | search "IPsec" in the ROS space | `ip/ipsec/*` |
| Queues | search "Queue" in the ROS space | `queue/*` |
| Containers | search "Container" in the ROS space | `container*` |

> When you add a row, search help.mikrotik.com for the feature, open the ROS-space
> page, confirm it loads, and paste its URL. Replace any "search …" cell with the
> verified deep link as you confirm it.

## RouterOS quirks (MikroMCP/RouterOS facts, not doc copies)

- Field names are **kebab-case**: `dst-address`, `routing-table`, `mac-address`.
- The id field is `.id` (e.g. `*1`).
- Booleans come back as the **strings** `"true"`/`"false"`, not JSON booleans.
- WiFi lives at `interface/wifi` on ROS 7.13+, `interface/wireless` on older.

# Tool map

Every MikroMCP tool, grouped by RouterOS area. Columns: what you want →
tool → REST path it hits → safety class (read / write / destructive).
The quick index in `SKILL.md` covers the common cases; this is the full set.

Multi-tool patterns:
- **Expose an internal service** = NAT dst-nat rule (`manage_firewall_rule` table
  `nat`) + an allow rule in `filter` + optionally an `address-list` entry.
- **New subnet on a port** = `manage_ip_address` + `manage_dhcp_server` (+ pool
  via `manage_ip_pool`) + a firewall rule.

## Firewall & NAT
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List filter/nat/mangle rules | `list_firewall_rules` | `ip/firewall/filter` | read |
| Add/remove/toggle a filter or NAT rule | `manage_firewall_rule` | `ip/firewall/filter`, `ip/firewall/nat` | destructive |
| List mangle rules | `list_mangle_rules` | `ip/firewall/mangle` | read |
| Add/remove a mangle rule | `manage_mangle_rule` | `ip/firewall/mangle` | write |
| List address-list entries | `list_address_list_entries` | `ip/firewall/address-list` | read |
| Add/remove an address-list entry | `manage_address_list_entry` | `ip/firewall/address-list` | write |
| List active connections | `list_connections` | `ip/firewall/connection` | read |

## System
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Get CPU, memory, uptime, version | `get_system_status` | `system/identity`, `system/resource` | read |
| Get current system clock | `get_system_clock` | `system/clock` | read |
| Set system clock | `set_system_clock` | `system/clock` | write |
| Reboot the router | `reboot` | `system/reboot` | destructive |
| Run an arbitrary RouterOS console command via SSH | `run_command` | SSH | destructive |

## Interfaces & Bridges
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List all interfaces | `list_interfaces` | `interface` | read |
| List bridge interfaces and settings | `list_bridges` | `interface/bridge` | read |
| Add/remove/modify a bridge | `manage_bridge` | `interface/bridge` | destructive |
| Add/remove a port to a bridge | `manage_bridge_port` | `interface/bridge/port` | destructive |
| List interface lists | `list_interface_lists` | `interface/list` | read |
| Add/remove an interface list | `manage_interface_list` | `interface/list` | write |
| Add/remove a member from an interface list | `manage_interface_list_member` | `interface/list/member` | write |
| List ARP table entries | `list_arp_entries` | `ip/arp` | read |
| List LLDP/CDP neighbors | `list_neighbors` | `ip/neighbor` | read |

## IP, DNS & Addressing
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Add/remove an IP address on an interface | `manage_ip_address` | `ip/address` | destructive |
| Get DNS resolver settings | `get_dns_settings` | `ip/dns` | read |
| Manage DNS resolver settings | `manage_dns_settings` | `ip/dns` | write |
| List static DNS entries | `list_dns_entries` | `ip/dns/static` | read |
| Add/remove a static DNS entry | `manage_dns_entry` | `ip/dns/static` | destructive |
| List IP service ports (ssh, api, www…) | `list_ip_services` | `ip/service` | read |
| Enable/disable/change port of an IP service | `manage_ip_service` | `ip/service` | destructive |
| List IP pools | `list_ip_pools` | `ip/pool` | read |
| Add/remove an IP pool | `manage_ip_pool` | `ip/pool` | write |

## DHCP
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List DHCP server leases | `list_dhcp_leases` | `ip/dhcp-server/lease` | read |
| Add/remove/toggle a DHCP lease | `manage_dhcp_lease` | `ip/dhcp-server/lease` | write |
| List DHCP servers | `list_dhcp_servers` | `ip/dhcp-server` | read |
| Add/remove/toggle a DHCP server | `manage_dhcp_server` | `ip/dhcp-server` | write |
| List DHCP clients (WAN-side) | `list_dhcp_clients` | `ip/dhcp-client` | read |
| Add/remove/toggle a DHCP client | `manage_dhcp_client` | `ip/dhcp-client` | destructive |

## Routing
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List static routes | `list_routes` | `ip/route` | read |
| Add/remove a static route | `manage_route` | `ip/route` | destructive |
| List routing rules (policy routing) | `list_routing_rules` | `routing/rule` | read |
| Add/remove a routing rule | `manage_routing_rule` | `routing/rule` | write |
| List routing tables | `list_routing_tables` | `routing/table` | read |
| Add/remove a routing table | `manage_routing_table` | `routing/table` | write |
| List BGP peers | `list_bgp_peers` | `routing/bgp/session` | read |
| List OSPF neighbors | `list_ospf_neighbors` | `routing/ospf/neighbor` | read |

## VPN — WireGuard
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List WireGuard interfaces | `list_wireguard_interfaces` | `interface/wireguard` | read |
| Add/remove a WireGuard interface | `manage_wireguard_interface` | `interface/wireguard` | write |
| List WireGuard peers | `list_wireguard_peers` | `interface/wireguard/peers` | read |
| Add/remove a WireGuard peer | `manage_wireguard_peer` | `interface/wireguard/peers` | destructive |

## VPN — OpenVPN
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Get OpenVPN server settings | `get_ovpn_server` | `interface/ovpn-server` | read |
| Configure OpenVPN server | `manage_ovpn_server` | `interface/ovpn-server/server` | destructive |
| List OpenVPN clients | `list_ovpn_clients` | `interface/ovpn-client` | read |
| Add/remove an OpenVPN client | `manage_ovpn_client` | `interface/ovpn-client` | destructive |

## VPN — IPSec
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List IPSec peers | `list_ipsec_peers` | `ip/ipsec/peer` | read |
| Add/remove an IPSec peer | `manage_ipsec_peer` | `ip/ipsec/peer` | destructive |
| List IPSec policies | `list_ipsec_policies` | `ip/ipsec/policy` | read |
| Add/remove an IPSec policy | `manage_ipsec_policy` | `ip/ipsec/policy` | write |

## VPN — PPP & PPPoE
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List PPP profiles | `list_ppp_profiles` | `ppp/profile` | read |
| Add/remove/update a PPP profile | `manage_ppp_profile` | `ppp/profile` | write |
| List PPPoE clients | `list_pppoe_clients` | `interface/pppoe-client` | read |
| Add/remove a PPPoE client | `manage_pppoe_client` | `interface/pppoe-client` | destructive |

## Wireless (WiFi)
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List WiFi interfaces | `list_wifi_interfaces` | `interface/wifi` | read |
| Enable/disable/update a WiFi interface | `manage_wifi_interface` | `interface/wifi` | write |
| List associated WiFi clients | `list_wifi_clients` | `interface/wifi` | read |

## Queues
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List simple queues | `list_queues` | `queue/simple` | read |
| Add/remove/update a simple queue | `manage_queue` | `queue/simple` | write |

## Users & Access
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List users | `list_users` | `user` | read |
| Add/remove/update a user | `manage_user` | `user` | write |
| List user groups | `list_user_groups` | `user/group` | read |
| Add/remove a user group | `manage_user_group` | `user/group` | write |

## Files, Scripts & Scheduler
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List files on the router | `list_files` | `file` | read |
| Read a file's contents | `get_file_content` | `file` | read |
| Upload a file to the router | `upload_file` | `file` | write |
| Delete a file | `delete_file` | `file` | destructive |
| List scripts | `list_scripts` | `system/script` | read |
| Add/remove/update a script | `manage_script` | `system/script` | write |
| Run a script by name | `run_script` | `system/script` | write |
| List scheduled jobs | `list_scheduled_jobs` | `system/scheduler` | read |
| Add/remove/update a scheduled job | `manage_scheduled_job` | `system/scheduler` | write |

## Containers
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List containers | `list_containers` | `container` | read |
| Add/remove/start/stop a container | `manage_container` | `container` | write |
| Get container registry/network config | `get_container_config` | `container/config` | read |
| Update container global config | `manage_container_config` | `container/config` | write |
| List container environment variables | `list_container_envs` | `container/envs` | read |
| Add/remove a container env var | `manage_container_env` | `container/envs` | write |
| List container volume mounts | `list_container_mounts` | `container/mounts` | read |
| Add/remove a container mount | `manage_container_mount` | `container/mounts` | write |

## Diagnostics
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Ping a host from the router | `ping` | `tool/ping` | read |
| Traceroute to a host | `traceroute` | `tool/traceroute` | read |
| Run a traffic capture (torch) | `torch` | `tool/torch` | read |
| Run a RouterOS bandwidth test | `bandwidth_test` | `tool/bandwidth-test` | read |
| Fetch a URL from the router | `fetch_url` | `tool/fetch` | read |
| Read the system log | `get_log` | `log` | read |

## Change Management & Fleet
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Preview a sequence of write operations | `plan_changes` | (orchestration) | write |
| Execute a previewed plan | `apply_plan` | (orchestration) | destructive |
| Roll back a previous change | `rollback_change` | (orchestration) | destructive |
| Run the same tool against multiple routers | `bulk_execute` | (orchestration) | write |
| Check health of a router | `check_router_health` | `system/resource` | read |
| Create a config backup/snapshot | `create_backup` | `system/backup/save` | write |
| Export running config | `export_config` | `system/export` | read |

## Logging
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List log actions (output targets) | `list_log_actions` | `system/logging/action` | read |
| Add/remove/update a log action | `manage_log_action` | `system/logging/action` | write |
| List log rules (topic → action mappings) | `list_log_rules` | `system/logging` | read |
| Add/remove/update a log rule | `manage_log_rule` | `system/logging` | write |

## Certificates
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List certificates | `list_certificates` | `certificate` | read |
| Import/remove a certificate | `manage_certificate` | `certificate` | destructive |

## Packages & Upgrade
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List installed packages | `list_packages` | `system/package` | read |
| Enable/disable a package | `manage_package` | `system/package` | write |
| Get pending upgrade status | `get_upgrade_status` | `system/package/update` | read |
| Check for updates / install upgrade | `manage_upgrade` | `system/package/update` | destructive |

## Network Services & Monitoring
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Get SNMP settings | `get_snmp_settings` | `snmp` | read |
| Get NTP client settings | `get_ntp_settings` | `system/ntp/client` | read |
| Configure NTP client | `manage_ntp_client` | `system/ntp/client` | write |
| List netwatch entries | `list_netwatch_entries` | `tool/netwatch` | read |
| Add/remove/update a netwatch entry | `manage_netwatch_entry` | `tool/netwatch` | write |

## VRRP
| Intent | Tool | REST path | Class |
|---|---|---|---|
| List VRRP instances | `list_vrrp_instances` | `interface/vrrp` | read |
| Add/remove/toggle a VRRP instance | `manage_vrrp_instance` | `interface/vrrp` | write |

## VLAN
| Intent | Tool | REST path | Class |
|---|---|---|---|
| Add/remove/enable/disable a VLAN interface | `manage_vlan` | `interface/vlan` | destructive |

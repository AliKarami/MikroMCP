# Full SwOS `.b` fixtures: CSS318-16G-2S+ on SwOS 2.19 (device capture)

Blobs read from a **CSS318-16G-2S+** running **SwOS 2.19**, over its `.b` HTTP
API, with a populated configuration: eight VLANs, every port in strict VLAN
mode with access and trunk ports, management restricted to one VLAN and three
ports, IGMP snooping with a querier, SNMP on.

Sanitized before committing (same rules as `test/fixtures/swos/README.md`):

| What | Replaced with |
|---|---|
| system MAC, root bridge MAC, second MAC | `02:00:00:00:00:31` |
| serial | `SWTEST000318` |
| identity | `MikroTik` |
| current and static IP, allow-from network | `192.168.88.1`, `192.168.88.0/24` |
| port names | `Port1` … `Port16`, `SFP+1`, `SFP+2` |
| SNMP community, contact, location | `public`, empty, empty |
| LACP partner MACs | zero |

Everything else, VLAN names included, is as the switch sent it. Key order,
value widths and the full key set are therefore the device's own; the
round-trip test re-encodes each blob byte-for-byte.

The synthetic set in `test/fixtures/swos-full/` stays: it describes a factory
switch, which the planner tests need as their starting point.

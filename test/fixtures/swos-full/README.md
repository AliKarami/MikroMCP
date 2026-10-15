# Full SwOS `.b` fixtures (synthetic)

Blobs in the **full SwOS** dialect (short mnemonic keys such as `en`, `nm`,
`vlan`, `dvid`), shaped like a **CSS318-16G-2S+IN**: 18 ports, the last two
SFP+ cages, firmware 2.19, factory VLAN settings.

These are **not device captures**. They were written by hand from the field
declarations in the SwOS 2.18 web UI script of a CSS326-24G-2S+ (same dialect)
to pin the codec for the full-SwOS key set before a CSS318 was available. Key
order, value widths and the exact field set of a real CSS318 may differ.

Sanitized real captures of the same switch live in
`test/fixtures/swos-full-real/` (a configured switch, not a factory one) and
are what put the CSS318 into `VERIFIED_FIRMWARE`. This set stays as the
factory-state starting point the planner tests build on.

| File     | Contents                                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| `sys.b`  | identity `MikroTik`, static/fallback IP 192.168.88.1, no management restriction, IVL/IGMP off |
| `link.b` | 18 ports enabled, ports 1 and 17 linked, SFP+ cages configured for 10G                        |
| `fwd.b`  | factory forwarding (no isolation), VLAN mode optional, default VLAN 1 everywhere              |
| `lacp.b` | every port passive LACP, no static group, no partner                                          |
| `snmp.b` | SNMP enabled, community `public`                                                              |
| `vlan.b` | empty VLAN table                                                                              |

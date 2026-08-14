# SwOS `.b` capture fixtures

Raw HTTP responses from a MikroTik **CSS610-8P-2S+** running SwOS Lite 2.21,
used to test the wire codec in `src/adapter/swos-protocol.ts` against real
firmware output rather than hand-written samples.

One file per endpoint, byte-identical to what the device returned — including
the zero padding (`0x00000000`), which the codec must preserve because the
firmware only accepts whole-blob writes.

`!stats.b.sample2` is a second capture of `!stats.b` taken **earlier**, so the
counters in `!stats.b` are greater than or equal to those in the sample. The
pair exercises monotonic counter decoding.

## Sanitization

These captures come from a live network. Identifying values were replaced with
synthetic ones; everything else is untouched:

| Field | Replacement |
|---|---|
| MAC addresses (`sys.b`, `!dhost.b`, `lacp.b`) | `02:00:00:00:00:NN` (locally administered), mapped consistently across files so LAG membership still lines up |
| Switch serial (`sys.b i04`) | `SWTEST00001` |
| Port names (`link.b i0a`) | generic role names |
| SFP module serials (`sfp.b i04`) | `SFPTESTSN0000N`, padded to the original field width |

Endpoints the test device had no data for (`acl.b`, `host.b`, `vlan.b`,
`!igmp.b`) are captured as empty `{}`/`[]` on purpose — they pin down the
"nothing configured" shape the decoder has to handle.

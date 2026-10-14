import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeEndpoint,
  dumpBlob,
  encodePasswordChange,
  fieldFor,
  parseWireBlob,
  profileOf,
  SWOS_SCHEMA,
  unmappedWireKeys,
} from "../../../src/adapter/swos-protocol.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures/swos-full");

const blobs: Record<string, string> = {};
for (const name of readdirSync(FIXTURES)) {
  if (name.endsWith(".b")) blobs[name] = readFileSync(join(FIXTURES, name), "utf8");
}

const field = (endpoint: string, name: string) => {
  const found = SWOS_SCHEMA[endpoint].fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name} in ${endpoint}`);
  return found;
};

describe("full SwOS dialect (CSS318-shaped fixtures)", () => {
  it("round-trips every fixture byte-for-byte", () => {
    expect(Object.keys(blobs).sort()).toEqual([
      "fwd.b",
      "lacp.b",
      "link.b",
      "snmp.b",
      "sys.b",
      "vlan.b",
    ]);
    for (const [name, raw] of Object.entries(blobs)) {
      expect(dumpBlob(parseWireBlob(raw)), name).toBe(raw.trim());
    }
  });

  it("maps every key of the fixtures to a schema field", () => {
    for (const name of ["sys.b", "link.b", "fwd.b", "snmp.b", "lacp.b"]) {
      const wire = parseWireBlob(blobs[name]) as Record<string, unknown>;
      expect(unmappedWireKeys(name, wire), name).toEqual([]);
    }
  });

  it("decodes sys.b with the full-SwOS keys", () => {
    const sys = decodeEndpoint("sys.b", blobs["sys.b"], 18) as Record<string, unknown>;
    expect(sys.model).toBe("CSS318-16G-2S+IN");
    expect(sys.version).toBe("2.19");
    expect(sys.identity).toBe("MikroTik");
    expect(sys.static_ip).toBe("192.168.88.1");
    expect(sys.addr_acq).toBe("DHCP with fallback");
    expect(sys.independent_vlan_lookup).toBe(false);
    expect(sys.igmp_snooping).toBe(false);
    expect(sys.cpu_temp).toBe(42);
    expect(sys.uptime).toBe(46.6); // centiseconds on the wire
    expect(sys.allow_from_ports).toEqual(Array(18).fill(true));
    expect(sys.dhcp_trusted_ports).toEqual(Array(18).fill(true));
    expect(sys.discovery_protocol).toEqual(Array(18).fill(true));
    expect(sys._raw).toEqual({});
  });

  it("sign-extends 32-bit temperatures (JS shifts would wrap at 32 bits)", () => {
    const sys = decodeEndpoint("sys.b", "{temp:0xfffffff6,btm1:0x0000002a}") as Record<
      string,
      unknown
    >;
    expect(sys.cpu_temp).toBe(-10);
    expect(sys.board_temp_1).toBe(42);
  });

  it("reads spdc as the configured speed and spd as the negotiated one", () => {
    const link = decodeEndpoint("link.b", blobs["link.b"]) as Record<string, unknown>;
    const configured = link.manual_speed as string[];
    const negotiated = link.speed as string[];
    expect(configured.slice(16)).toEqual(["10G", "10G"]);
    expect(negotiated[2]).toBe("100M");
    expect(link.port_count).toBe(18);
    expect(link.sfp_offset).toBe(16);
    expect((link.name as string[])[16]).toBe("SFP+1");
  });

  it("decodes the per-port VLAN settings and 18 isolation masks from fwd.b", () => {
    const fwd = decodeEndpoint("fwd.b", blobs["fwd.b"]) as Record<string, unknown>;
    expect(fwd.vlan_mode).toEqual(Array(18).fill("optional"));
    expect(fwd.vlan_recv_mode).toEqual(Array(18).fill("any"));
    expect(fwd.default_vid).toEqual(Array(18).fill(1));
    expect(fwd.force_vid).toEqual(Array(18).fill(false));
    expect(fwd.storm_rate).toEqual(Array(18).fill(100));
    const p1 = fwd.isolation_p1 as boolean[];
    expect(p1).toHaveLength(18);
    expect(p1[0]).toBe(false);
    expect(p1.slice(1).every(Boolean)).toBe(true);
    expect(fwd.isolation_p18).toBeDefined();
    expect(fwd.isolation_p19).toBeUndefined();
  });

  it("decodes the four full-SwOS VLAN modes, including 'enabled'", () => {
    const fwd = parseWireBlob(blobs["fwd.b"]) as Record<string, unknown>;
    fwd.vlan = ["0x00", "0x01", "0x02", "0x03", ...Array(14).fill("0x03")];
    const decoded = decodeEndpoint("fwd.b", dumpBlob(fwd)) as Record<string, unknown>;
    expect((decoded.vlan_mode as string[]).slice(0, 4)).toEqual([
      "disabled",
      "optional",
      "enabled",
      "strict",
    ]);
  });

  it("keeps the three-entry Lite VLAN mode list for SwOS Lite keys", () => {
    const decoded = decodeEndpoint("fwd.b", "{i15:[0x00,0x01,0x02]}") as Record<string, unknown>;
    expect(decoded.vlan_mode).toEqual(["disabled", "optional", "strict"]);
  });

  it("decodes VLAN table members to the switch's port count", () => {
    const raw =
      "[{vid:0x0064,nm:'4d474d54',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x020003}," +
      "{vid:0x0190,nm:'4755455354',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000700}]";
    const rows = decodeEndpoint("vlan.b", raw, 18) as Record<string, unknown>[];
    expect(rows[0].vid).toBe(100);
    expect(rows[0].name).toBe("MGMT");
    const members = rows[0].members as boolean[];
    expect(members).toHaveLength(18);
    const ports = members.flatMap((on, i) => (on ? [i + 1] : []));
    expect(ports).toEqual([1, 2, 18]);
    expect(rows[1].name).toBe("GUEST");
    expect(rows[1]._raw).toEqual({});
  });

  it("decodes record bitmasks to their highest set bit when the port count is unknown", () => {
    const rows = decodeEndpoint("vlan.b", "[{vid:0x0014,mbr:0x0a}]") as Record<string, unknown>[];
    expect(rows[0].members).toEqual([false, true, false, true]);
  });

  it("applies a dialect override only for that dialect's key", () => {
    const vlanMode = field("fwd.b", "vlan_mode");
    expect(profileOf(vlanMode, "vlan")).toBe("swos");
    expect(profileOf(vlanMode, "i15")).toBe("swos_lite");
    expect(fieldFor(vlanMode, "vlan").options).toContain("enabled");
    expect(fieldFor(vlanMode, "i15").options).not.toContain("enabled");
    expect(fieldFor(vlanMode, undefined)).toBe(vlanMode);
  });

  it("serves the full-SwOS stats.b path with mnemonic metric aliases", () => {
    const stats = decodeEndpoint(
      "stats.b",
      "{rb:[0x10,0x20],tb:[0x01,0x02],rfcs:[0x00,0x03]}",
    ) as Record<string, Record<string, unknown>>;
    expect(stats["2"].rx_bytes).toBe(0x20);
    expect(stats["2"].rx_fcs_errors).toBe(3);
  });

  it("encodes a password change exactly as the SwOS web UI does", () => {
    // Expected values come from running the web UI's own ra() (SwOS 2.18
    // script) under node; lanrat/python-mikrotik-swos produces the same hex.
    const vectors: [string, string, string][] = [
      ["", "secret", "6467d84816731f6271272cf3dd1464ad0f479a5109cdc8e40d14998fdcbef5df"],
      ["oldpass", "newpass", "5d740662c8c0ddabab3664b828d34a0973d18f535181b7ee3797a19dbfb25ba6"],
      [
        "123456789012345",
        "abcdefghijklmno",
        "9657aa4aec17114a698c22d70664105cc881279e013e943607782c9336b4cc89",
      ],
      ["x", "", "4d9b87afd1a91dc25347dfe44f6fd25d2fd14465e5f5eb5c7d3cc6f911c4936d"],
    ];
    for (const [oldPwd, newPwd, hex] of vectors) {
      expect(encodePasswordChange(oldPwd, newPwd), `${oldPwd} -> ${newPwd}`).toBe(hex);
    }
  });
});

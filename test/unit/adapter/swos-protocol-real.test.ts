import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeEndpoint,
  dumpBlob,
  firmwareSupport,
  parseWireBlob,
  unmappedWireKeys,
} from "../../../src/adapter/swos-protocol.js";
import {
  parseSwitchConfig,
  planSwitchConfig,
  type CurrentBlobs,
} from "../../../src/domain/swos/switch-config.js";
import { exportSwitchConfig } from "../../../src/domain/tools/swos-config-tools.js";

const REAL = join(import.meta.dirname, "../../fixtures/swos-full-real");

const blobs: Record<string, string> = {};
for (const name of readdirSync(REAL)) {
  if (name.endsWith(".b")) blobs[name] = readFileSync(join(REAL, name), "utf8");
}
const PORTS = 18;
const decoded = (ep: string) => decodeEndpoint(ep, blobs[ep], PORTS) as Record<string, unknown>;
const ports = (bits: unknown) => (bits as boolean[]).flatMap((on, i) => (on ? [i + 1] : []));

describe("CSS318-16G-2S+ on SwOS 2.19, as captured", () => {
  it("round-trips every blob byte-for-byte", () => {
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

  it("maps every key the switch sends to a schema field", () => {
    for (const name of ["sys.b", "link.b", "fwd.b", "snmp.b", "lacp.b"]) {
      expect(
        unmappedWireKeys(name, parseWireBlob(blobs[name]) as Record<string, unknown>),
        name,
      ).toEqual([]);
    }
    for (const row of decoded("vlan.b") as unknown as Record<string, unknown>[]) {
      expect(row._raw).toEqual({});
    }
  });

  it("is a verified firmware", () => {
    const sys = decoded("sys.b");
    expect(firmwareSupport(sys.model, sys.version)).toMatchObject({ verified: true });
  });

  it("decodes the system settings", () => {
    const sys = decoded("sys.b");
    expect(sys).toMatchObject({
      model: "CSS318-16G-2S+",
      version: "2.19",
      identity: "MikroTik",
      serial: "SWTEST000318",
      ip: "192.168.88.1",
      static_ip: "192.168.88.1",
      addr_acq: "static",
      independent_vlan_lookup: true,
      igmp_snooping: true,
      igmp_querier: true,
      igmp_version: "v3",
      cpu_temp: 61,
      uptime: 24366.25, // 0x252e11 centiseconds
      allow_from_ip: "192.168.88.0",
      allow_from_mask: 24,
      allow_from_vlan: 10,
      watchdog: true,
      discovery_enabled: true,
      eth_boot_port: true,
      bridge_priority: 0x8000,
      root_bridge_priority: 0x8000,
    });
    expect(ports(sys.allow_from_ports)).toEqual([15, 16, 17]);
    expect(ports(sys.dhcp_trusted_ports)).toEqual([1, 17]);
    expect(ports(sys.discovery_protocol)).toEqual([]);
    expect(sys._raw).toEqual({});
  });

  it("decodes the link table", () => {
    const link = decoded("link.b");
    expect(link.port_count).toBe(18);
    expect(link.sfp_count).toBe(2);
    expect(link.sfp_offset).toBe(16);
    expect(ports(link.link)).toEqual([1, 3, 7, 15, 16, 17]);
    expect(ports(link.enabled)).toEqual([1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect((link.speed as string[])[16]).toBe("10G");
    expect((link.speed as string[])[0]).toBe("1G");
    expect((link.name as string[])[17]).toBe("SFP+2");
    expect(link.cable_pairs).toEqual(Array(18).fill(0xffff));
    expect(ports(link.flow_tx_active)).toEqual([3, 15, 16, 17]);
  });

  it("decodes the per-port VLAN settings and the VLAN table", () => {
    const fwd = decoded("fwd.b");
    expect(fwd.vlan_mode).toEqual(Array(18).fill("strict"));
    expect(fwd.default_vid).toEqual([
      99, 99, 1, 20, 20, 50, 20, 99, 30, 30, 30, 30, 40, 40, 99, 10, 1, 1,
    ]);
    const recv = fwd.vlan_recv_mode as string[];
    expect(recv[0]).toBe("only_untagged");
    expect(recv[2]).toBe("only_tagged");
    expect(recv[11]).toBe("any");
    expect(recv[16]).toBe("only_tagged");
    expect(fwd.storm_rate).toEqual(Array(18).fill(100));

    const rows = decoded("vlan.b") as unknown as Record<string, unknown>[];
    expect(rows.map((r) => [r.vid, r.name])).toEqual([
      [10, "MGMT"],
      [20, "SERVERS"],
      [30, "LAN"],
      [40, "IOT"],
      [50, "APPS"],
      [60, "DEV"],
      [80, "TV"],
      [99, "ISP"],
    ]);
    expect(ports(rows[0].members)).toEqual([3, 12, 15, 16, 17]);
    expect(rows[1].igmp).toBe(true);
    expect(ports(rows[7].members)).toEqual([1, 2, 8, 15, 17]);
  });

  describe("the config tools on the captured switch", () => {
    const current = (): Required<CurrentBlobs> =>
      Object.fromEntries(
        Object.entries(blobs).map(([ep, raw]) => [ep, parseWireBlob(raw)]),
      ) as Required<CurrentBlobs>;

    it("exports a document that applies back as no change", () => {
      const doc = exportSwitchConfig(current());
      expect((doc.vlans as unknown[]).length).toBe(8);
      expect((doc.system as Record<string, unknown>).allow_from).toBe("192.168.88.0/24");
      expect((doc.system as Record<string, unknown>).allow_from_vlan).toBe(10);
      const plan = planSwitchConfig(parseSwitchConfig(doc), current());
      expect(plan.writes).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.management).toEqual([]);
    });

    it("flags pruning the management VLAN and taking a management port out of it", () => {
      const doc = exportSwitchConfig(current());
      const vlans = (doc.vlans as { id: number; members: number[] }[]).filter((v) => v.id !== 10);
      const pruned = planSwitchConfig(parseSwitchConfig({ version: 1, vlans }), current());
      expect(pruned.warnings).toContain(
        "Management is allowed from VLAN 10 only, which would no longer be in the VLAN table.",
      );
      const shrunk = (doc.vlans as { id: number; members: number[] }[]).map((v) =>
        v.id === 10 ? { ...v, members: v.members.filter((p) => p !== 17) } : v,
      );
      const dropped = planSwitchConfig(parseSwitchConfig({ version: 1, vlans: shrunk }), current());
      expect(dropped.warnings).toContain(
        "Management is allowed from VLAN 10 only, and linked port(s) 17 would not be members of it.",
      );
    });
  });
});

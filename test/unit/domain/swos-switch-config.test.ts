import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEndpoint, parseWireBlob } from "../../../src/adapter/swos-protocol.js";
import {
  parseSwitchConfig,
  redactConfigParam,
  planSwitchConfig,
  unionVlanBlob,
  type CurrentBlobs,
  type ConfigPlan,
} from "../../../src/domain/swos/switch-config.js";

const FULL = join(import.meta.dirname, "../../fixtures/swos-full");
const LITE = join(import.meta.dirname, "../../fixtures/swos");
const wire = (dir: string, name: string) => parseWireBlob(readFileSync(join(dir, name), "utf8"));

function factory(): CurrentBlobs {
  return {
    "sys.b": wire(FULL, "sys.b"),
    "link.b": wire(FULL, "link.b"),
    "fwd.b": wire(FULL, "fwd.b"),
    "vlan.b": wire(FULL, "vlan.b"),
    "snmp.b": wire(FULL, "snmp.b"),
  };
}

/** A small office layout on an 18-port switch: two access VLANs, one trunk, one uplink. */
const OFFICE = `
version: 1
system:
  identity: office-sw
  independent_vlan_lookup: true
  igmp_snooping: true
  igmp_querier: true
  mikrotik_discovery: []
  dhcp_trusted_ports: [17]
ports:
  1:  { name: desk-1, vlan_mode: strict, vlan_receive: only_untagged, default_vlan: 200 }
  2:  { name: desk-2, vlan_mode: strict, vlan_receive: only_untagged, default_vlan: 200 }
  3:  { name: printer, vlan_mode: strict, vlan_receive: only_untagged, default_vlan: 300 }
  8:  { name: service, vlan_mode: strict, vlan_receive: only_untagged, default_vlan: 100 }
  17: { name: uplink, vlan_mode: strict, vlan_receive: only_tagged, default_vlan: 1 }
  18: { name: spare-10g, enabled: false, vlan_mode: strict, vlan_receive: only_tagged, default_vlan: 1 }
vlans:
  - { id: 100, name: MGMT, members: [8, 17] }
  - { id: 200, name: STAFF, members: [1, 2, 17], igmp_snooping: true }
  - { id: 300, name: DEVICES, members: [3, 17] }
snmp:
  enabled: true
  community: \${SNMP_COMMUNITY}
  location: rack
`;

const ENV = { SNMP_COMMUNITY: "s3cret-community" };

/** Feed a plan's blobs back as the new current state, as if the switch applied them. */
function applied(current: CurrentBlobs, plan: ConfigPlan): CurrentBlobs {
  const next = { ...current };
  for (const ep of plan.endpoints) if (ep.blob) next[ep.endpoint] = parseWireBlob(ep.blob);
  return next;
}

const changesOf = (plan: ConfigPlan, endpoint: string) =>
  plan.endpoints.find((e) => e.endpoint === endpoint)?.changes ?? [];

describe("parseSwitchConfig", () => {
  it("parses YAML and resolves ${ENV} secrets", () => {
    const config = parseSwitchConfig(OFFICE, ENV);
    expect(config.snmp?.community).toBe("s3cret-community");
    expect(config.vlans).toHaveLength(3);
    // No defaults at parse time: an existing VLAN keeps what the document leaves out.
    expect(config.vlans?.[0].port_isolation).toBeUndefined();
  });

  it("names a secret that is not set instead of writing the placeholder", () => {
    expect(() => parseSwitchConfig(OFFICE, {})).toThrowError(
      expect.objectContaining({ code: "SWOS_CONFIG_SECRET_MISSING" }),
    );
  });

  it("rejects unknown settings", () => {
    expect(() => parseSwitchConfig({ version: 1, ports: { 1: { colour: "red" } } })).toThrowError(
      expect.objectContaining({ code: "SWOS_CONFIG_INVALID" }),
    );
  });

  it("rejects a VLAN listed twice", () => {
    const doc = {
      version: 1,
      vlans: [
        { id: 10, members: [1] },
        { id: 10, members: [2] },
      ],
    };
    expect(() => parseSwitchConfig(doc)).toThrowError(/VLAN 10 is listed more than once/);
  });

  it("rejects malformed YAML with a parse error", () => {
    expect(() => parseSwitchConfig("version: [1")).toThrowError(
      expect.objectContaining({ code: "SWOS_CONFIG_PARSE_ERROR" }),
    );
  });
});

describe("planSwitchConfig on a factory full-SwOS switch", () => {
  const config = parseSwitchConfig(OFFICE, ENV);
  const plan = planSwitchConfig(config, factory());

  it("detects the dialect and port count", () => {
    expect(plan.dialect).toBe("swos");
    expect(plan.portCount).toBe(18);
  });

  it("orders the writes VLAN table first and system last", () => {
    expect(plan.endpoints.map((e) => e.endpoint)).toEqual([
      "vlan.b",
      "fwd.b",
      "link.b",
      "snmp.b",
      "sys.b",
    ]);
  });

  it("adds the VLAN table with member masks sized to the switch", () => {
    const blob = plan.endpoints.find((e) => e.endpoint === "vlan.b")?.blob ?? "";
    const rows = decodeEndpoint("vlan.b", blob, 18) as Record<string, unknown>[];
    expect(rows.map((r) => r.vid)).toEqual([100, 200, 300]);
    expect(rows.map((r) => r.name)).toEqual(["MGMT", "STAFF", "DEVICES"]);
    const members = (rows[1].members as boolean[]).flatMap((on, i) => (on ? [i + 1] : []));
    expect(members).toEqual([1, 2, 17]);
    expect(rows[1].igmp).toBe(true);
    // A new VLAN takes the web UI's defaults for what the document omits.
    expect(rows[0]).toMatchObject({
      port_isolation: true,
      learning: true,
      mirror: false,
      igmp: false,
    });
    expect(changesOf(plan, "vlan.b").every((c) => c.setting === "add")).toBe(true);
  });

  it("sets the per-port VLAN settings and leaves unlisted ports alone", () => {
    const blob = plan.endpoints.find((e) => e.endpoint === "fwd.b")?.blob ?? "";
    const fwd = decodeEndpoint("fwd.b", blob, 18) as Record<string, unknown[]>;
    expect(fwd.vlan_mode.slice(0, 4)).toEqual(["strict", "strict", "strict", "optional"]);
    expect(fwd.default_vid[0]).toBe(200);
    expect(fwd.default_vid[7]).toBe(100);
    expect(fwd.vlan_recv_mode[16]).toBe("only_tagged");
    expect(fwd.default_vid[4]).toBe(1);
  });

  it("names and disables ports in link.b", () => {
    const blob = plan.endpoints.find((e) => e.endpoint === "link.b")?.blob ?? "";
    const link = decodeEndpoint("link.b", blob, 18) as Record<string, unknown[]>;
    expect(link.name[16]).toBe("uplink");
    expect(link.name[4]).toBe("Port5");
    expect(link.enabled[17]).toBe(false);
    expect(link.enabled[16]).toBe(true);
  });

  it("writes the SNMP community but never shows it in the plan", () => {
    const snmp = decodeEndpoint(
      "snmp.b",
      plan.endpoints.find((e) => e.endpoint === "snmp.b")?.blob ?? "",
    ) as Record<string, unknown>;
    expect(snmp.community).toBe("s3cret-community");
    const change = changesOf(plan, "snmp.b").find((c) => c.setting === "snmp.community");
    expect(change).toMatchObject({ from: "<redacted>", to: "<redacted>" });
    expect(JSON.stringify(plan.endpoints.map((e) => e.changes))).not.toContain("s3cret");
  });

  it("applies the system switches without touching management", () => {
    const sys = decodeEndpoint(
      "sys.b",
      plan.endpoints.find((e) => e.endpoint === "sys.b")?.blob ?? "",
      18,
    ) as Record<string, unknown>;
    expect(sys.identity).toBe("office-sw");
    expect(sys.independent_vlan_lookup).toBe(true);
    expect(sys.igmp_querier).toBe(true);
    expect(sys.discovery_protocol).toEqual(Array(18).fill(false));
    expect((sys.dhcp_trusted_ports as boolean[]).flatMap((on, i) => (on ? [i + 1] : []))).toEqual([
      17,
    ]);
    expect(sys.static_ip).toBe("192.168.88.1");
    expect(plan.management).toEqual([]);
  });

  it("is idempotent: re-planning against the applied state changes nothing", () => {
    const again = planSwitchConfig(config, applied(factory(), plan));
    expect(again.endpoints.flatMap((e) => e.changes)).toEqual([]);
    expect(again.endpoints.every((e) => e.blob === undefined)).toBe(true);
  });

  it("re-sends untouched keys of an endpoint byte-for-byte", () => {
    const before = factory()["fwd.b"] as Record<string, unknown>;
    const after = parseWireBlob(
      plan.endpoints.find((e) => e.endpoint === "fwd.b")?.blob ?? "",
    ) as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      if (["vlan", "vlni", "dvid"].includes(key)) continue;
      expect(after[key], key).toEqual(before[key]);
    }
  });
});

describe("planSwitchConfig safeguards", () => {
  it("collects management changes separately", () => {
    const config = parseSwitchConfig({
      version: 1,
      system: {
        address_acquisition: "static",
        static_ip: "192.168.88.2",
        allow_from: "192.168.88.0/24",
        allow_from_ports: [1, 2],
        allow_from_vlan: 100,
      },
    });
    const plan = planSwitchConfig(config, factory());
    expect(plan.management.map((c) => c.setting)).toEqual([
      "address_acquisition",
      "static_ip",
      "allow_from",
      "allow_from",
      "allow_from_ports",
      "allow_from_vlan",
    ]);
    const sys = decodeEndpoint("sys.b", plan.endpoints[0].blob ?? "", 18) as Record<
      string,
      unknown
    >;
    expect(sys.static_ip).toBe("192.168.88.2");
    expect(sys.allow_from_ip).toBe("192.168.88.0");
    expect(sys.allow_from_mask).toBe(24);
  });

  it("warns when a linked strict access port is not in its own default VLAN", () => {
    const doc = (port: number) => ({
      version: 1,
      ports: { [port]: { vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 } },
      vlans: [{ id: 100, members: [17] }],
    });
    // Port 1 has a link: its untagged traffic moves to VLAN 100 and is then dropped there.
    const plan = planSwitchConfig(parseSwitchConfig(doc(1)), factory());
    expect(plan.warnings).toEqual([
      "Port 1 has a link and its untagged traffic would move from VLAN 1 to VLAN 100.",
      "Port 1 is strict with default VLAN 100, but is not a member of VLAN 100: its untagged traffic will be dropped.",
    ]);
    // Port 8 has no link: nobody is cut off, no warning.
    expect(planSwitchConfig(parseSwitchConfig(doc(8)), factory()).warnings).toEqual([]);
  });

  it("keeps VLANs that are not in the config when pruning is off", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0190,nm:'4755455354',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000001}]",
    );
    const config = parseSwitchConfig({ version: 1, vlans: [{ id: 100, members: [8] }] });

    const pruned = planSwitchConfig(config, seeded);
    expect(changesOf(pruned, "vlan.b").map((c) => [c.setting, c.vlan])).toEqual([
      ["add", 100],
      ["remove", 400],
    ]);

    const kept = planSwitchConfig(config, seeded, { pruneVlans: false });
    const rows = decodeEndpoint("vlan.b", kept.endpoints[0].blob ?? "", 18) as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.vid)).toEqual([100, 400]);
  });

  it("edits an existing VLAN in place, keeping its other keys", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0064,nm:'4d474d54',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000080,xyz:0x07}]",
    );
    const config = parseSwitchConfig({
      version: 1,
      vlans: [{ id: 100, name: "MGMT", members: [8, 17] }],
    });
    const plan = planSwitchConfig(config, seeded);
    expect(changesOf(plan, "vlan.b")).toEqual([
      { endpoint: "vlan.b", setting: "members", vlan: 100, from: [8], to: [8, 17] },
    ]);
    const row = (parseWireBlob(plan.endpoints[0].blob ?? "") as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ mbr: "0x010080", xyz: "0x07", nm: "4d474d54" });
  });

  it("refuses a port number the switch does not have", () => {
    const config = parseSwitchConfig({ version: 1, vlans: [{ id: 100, members: [24] }] });
    expect(() => planSwitchConfig(config, factory())).toThrowError(/port\(s\) 24.*18 ports/);
  });

  it("refuses to write the VLAN table on SwOS Lite", () => {
    const lite: CurrentBlobs = {
      "sys.b": wire(LITE, "sys.b"),
      "link.b": wire(LITE, "link.b"),
      "vlan.b": wire(LITE, "vlan.b"),
    };
    const config = parseSwitchConfig({ version: 1, vlans: [{ id: 100, members: [1] }] });
    expect(() => planSwitchConfig(config, lite)).toThrowError(
      expect.objectContaining({ code: "SWOS_VLAN_TABLE_UNSUPPORTED" }),
    );
  });

  it("plans SwOS Lite per-port VLAN settings with the Lite option list", () => {
    const lite: CurrentBlobs = {
      "sys.b": wire(LITE, "sys.b"),
      "link.b": wire(LITE, "link.b"),
      "fwd.b": wire(LITE, "fwd.b"),
    };
    const config = parseSwitchConfig({
      version: 1,
      ports: { 1: { vlan_mode: "strict", default_vlan: 200 } },
    });
    const plan = planSwitchConfig(config, lite);
    const wireFwd = parseWireBlob(plan.endpoints[0].blob ?? "") as Record<string, string[]>;
    expect(wireFwd.i15[0]).toBe("0x02");
    expect(wireFwd.i18[0]).toBe("0x00c8");
  });

  it("names a setting the firmware does not expose", () => {
    const sys = factory();
    const trimmed = { ...(sys["sys.b"] as Record<string, unknown>) };
    delete trimmed.ivl;
    sys["sys.b"] = trimmed;
    const config = parseSwitchConfig({ version: 1, system: { independent_vlan_lookup: true } });
    expect(() => planSwitchConfig(config, sys)).toThrowError(
      expect.objectContaining({ code: "SWOS_FIELD_NOT_ON_DEVICE" }),
    );
  });
});

describe("review regressions", () => {
  /** A switch where everything lives in VLAN 1: strict ports, default VLAN 1, ports 5 and 8 linked. */
  function vlanOneSwitch(): CurrentBlobs {
    const blobs = factory();
    const fwd = { ...(blobs["fwd.b"] as Record<string, unknown>) };
    fwd.vlan = Array(18).fill("0x03");
    blobs["fwd.b"] = fwd;
    blobs["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'64656661756c74',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}]",
    );
    const link = { ...(blobs["link.b"] as Record<string, unknown>) };
    link.lnk = "0x000090";
    blobs["link.b"] = link;
    return blobs;
  }

  it("grows the VLAN table before the per-port writes and removes VLANs only after them", () => {
    const config = parseSwitchConfig({
      version: 1,
      ports: { 8: { vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 } },
      vlans: [{ id: 100, name: "MGMT", members: [8] }],
    });
    const plan = planSwitchConfig(config, vlanOneSwitch());
    expect(plan.writes.map((w) => `${w.endpoint}:${w.phase}`)).toEqual([
      "vlan.b:grow",
      "fwd.b:apply",
      "vlan.b:shrink",
    ]);
    const grow = decodeEndpoint("vlan.b", plan.writes[0].blob, 18) as Record<string, unknown>[];
    expect(grow.map((r) => r.vid)).toEqual([1, 100]);
    const final = decodeEndpoint("vlan.b", plan.writes[2].blob, 18) as Record<string, unknown>[];
    expect(final.map((r) => r.vid)).toEqual([100]);
  });

  it("flags every port the pruned table would cut off, not only the ports the document names", () => {
    const config = parseSwitchConfig({
      version: 1,
      ports: { 8: { vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 } },
      vlans: [{ id: 100, members: [8] }],
    });
    const plan = planSwitchConfig(config, vlanOneSwitch());
    // Port 5 (linked, not named) loses VLAN 1 under it; port 8 (linked, named) moves VLAN;
    // the 16 unlinked ports in the same situation cut nobody off and stay quiet.
    expect(plan.warnings).toEqual([
      "Port 8 has a link and its untagged traffic would move from VLAN 1 to VLAN 100.",
      "Port 5 is strict with default VLAN 1, but is not a member of VLAN 1: its untagged traffic will be dropped.",
    ]);
  });

  it("does not gate on a problem the switch already has", () => {
    // Port 5 is linked, strict, default VLAN 1, and VLAN 1 is already missing from the table.
    const seeded = vlanOneSwitch();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0064,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000080}]",
    );
    const rename = parseSwitchConfig({ version: 1, ports: { 2: { name: "jetkvm" } } });
    expect(planSwitchConfig(rename, seeded).warnings).toEqual([]);
  });

  it("writes the table last when the plan only removes (nothing to grow first)", () => {
    // Port 8 is strict in VLAN 10 and already a member of VLAN 20; the config
    // moves its default VLAN to 20 and empties VLAN 10. The old plan wrote the
    // shrunken table in the grow phase, before fwd.b moved the port.
    const seeded = factory();
    const fwd = { ...(seeded["fwd.b"] as Record<string, unknown>) };
    fwd.vlan = Array(18).fill("0x03");
    fwd.dvid = Array(18).fill("0x0001");
    (fwd.dvid as string[])[7] = "0x000a";
    seeded["fwd.b"] = fwd;
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ff7f}," +
        "{vid:0x000a,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000080}," +
        "{vid:0x0014,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000080}]",
    );
    const config = parseSwitchConfig({
      version: 1,
      ports: { 8: { default_vlan: 20 } },
      vlans: [
        { id: 1, members: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] },
        { id: 10, members: [] },
        { id: 20, members: [8] },
      ],
    });
    const plan = planSwitchConfig(config, seeded);
    expect(plan.writes.map((w) => `${w.endpoint}:${w.phase}`)).toEqual([
      "fwd.b:apply",
      "vlan.b:shrink",
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("writes the shrunken table last when a VLAN is pruned and nothing is added", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}," +
        "{vid:0x0063,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000000}]",
    );
    const config = parseSwitchConfig({
      version: 1,
      ports: { 8: { name: "renamed" } },
      vlans: [{ id: 1, members: Array.from({ length: 18 }, (_, i) => i + 1) }],
    });
    const plan = planSwitchConfig(config, seeded);
    expect(plan.writes.map((w) => `${w.endpoint}:${w.phase}`)).toEqual([
      "link.b:apply",
      "vlan.b:shrink",
    ]);
  });

  it("warns when a linked port would accept tagged frames only", () => {
    const config = parseSwitchConfig({
      version: 1,
      ports: { 17: { vlan_receive: "only_tagged" } },
    });
    const plan = planSwitchConfig(config, factory());
    expect(plan.warnings).toEqual([
      "Port 17 has a link and would accept tagged frames only; untagged traffic on it, management included, is dropped.",
    ]);
    // Not linked: no risk.
    const spare = parseSwitchConfig({ version: 1, ports: { 18: { vlan_receive: "only_tagged" } } });
    expect(planSwitchConfig(spare, factory()).warnings).toEqual([]);
  });

  it("warns when a linked trunk leaves a tagged VLAN, by membership or by pruning", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}," +
        "{vid:0x0064,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x010080}," +
        "{vid:0x00c8,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x010003}]",
    );
    const all = Array.from({ length: 18 }, (_, i) => i + 1);
    // Port 17 (linked) is taken out of VLAN 100 and VLAN 200 is pruned.
    const config = parseSwitchConfig({
      version: 1,
      vlans: [
        { id: 1, members: all },
        { id: 100, members: [8] },
      ],
    });
    const plan = planSwitchConfig(config, seeded);
    expect(plan.warnings).toEqual([
      "Port 1 has a link and would leave VLAN(s) 200; tagged traffic in them stops on this port.",
      "Port 17 has a link and would leave VLAN(s) 100, 200; tagged traffic in them stops on this port.",
    ]);
    // Turning the linked trunk into an access port in the same plan loses every
    // tagged VLAN it carried; the trunk is judged from the state before the plan.
    const access = parseSwitchConfig({
      version: 1,
      ports: { 17: { vlan_receive: "only_untagged" } },
      vlans: [
        { id: 1, members: all },
        { id: 100, members: [8] },
      ],
    });
    expect(planSwitchConfig(access, seeded).warnings).toEqual([
      "Port 1 has a link and would leave VLAN(s) 200; tagged traffic in them stops on this port.",
      "Port 17 has a link and would accept untagged frames only; tagged traffic in VLAN(s) 100, 200 stops on this port.",
    ]);
    // A port that already takes untagged frames only is no trunk: no warning for it.
    const seededAccess = { ...seeded };
    const fwd = { ...(seeded["fwd.b"] as Record<string, unknown>) };
    fwd.vlni = Array.from({ length: 18 }, (_, i) => (i === 16 ? "0x02" : "0x00"));
    seededAccess["fwd.b"] = fwd;
    expect(planSwitchConfig(access, seededAccess).warnings).toEqual([
      "Port 1 has a link and would leave VLAN(s) 200; tagged traffic in them stops on this port.",
    ]);
  });

  it("warns when the VLAN management is allowed from is pruned or loses the management port", () => {
    const seeded = factory();
    const sys = { ...(seeded["sys.b"] as Record<string, unknown>) };
    sys.avln = "0x0064"; // management from VLAN 100 only
    sys.allp = "0x010000"; // and from port 17 only
    seeded["sys.b"] = sys;
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}," +
        "{vid:0x0064,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x010080}]",
    );
    const all = Array.from({ length: 18 }, (_, i) => i + 1);
    const pruned = planSwitchConfig(
      parseSwitchConfig({ version: 1, vlans: [{ id: 1, members: all }] }),
      seeded,
    );
    expect(pruned.warnings).toContain(
      "Management is allowed from VLAN 100 only, which would no longer be in the VLAN table.",
    );
    const dropped = planSwitchConfig(
      parseSwitchConfig({
        version: 1,
        vlans: [
          { id: 1, members: all },
          { id: 100, members: [8] },
        ],
      }),
      seeded,
    );
    expect(dropped.warnings).toContain(
      "Management is allowed from VLAN 100 only, and linked port(s) 17 would not be members of it.",
    );
    // Setting the management VLAN to one the port is in produces no warning.
    const moved = planSwitchConfig(
      parseSwitchConfig({ version: 1, system: { allow_from_vlan: 1 } }),
      seeded,
    );
    expect(moved.warnings).toEqual([]);
  });

  it("refuses to plan without link.b and sys.b as a MikroMCPError", () => {
    expect(() => planSwitchConfig(parseSwitchConfig({ version: 1 }), {})).toThrow(
      expect.objectContaining({ code: "SWOS_PLAN_INPUT_MISSING" }),
    );
  });

  it("refuses a literal community when told the config came as text", () => {
    expect(() =>
      parseSwitchConfig(
        { version: 1, snmp: { community: "public" } },
        {},
        {
          communityByReferenceOnly: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "SWOS_CONFIG_SECRET_REQUIRED" }));
    expect(
      parseSwitchConfig(
        { version: 1, snmp: { community: "${C}" } },
        { C: "public" },
        { communityByReferenceOnly: true },
      ).snmp?.community,
    ).toBe("public");
  });

  it("writes a single vlan.b when the table only grows", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000003}]",
    );
    const config = parseSwitchConfig({
      version: 1,
      vlans: [
        { id: 1, members: [1, 2] },
        { id: 100, members: [8] },
      ],
    });
    const plan = planSwitchConfig(config, seeded);
    expect(plan.writes.map((w) => `${w.endpoint}:${w.phase}`)).toEqual(["vlan.b:grow"]);
  });

  it("flags a filtering port whose default VLAN is not in the table, and a linked port being disabled", () => {
    const config = parseSwitchConfig({
      version: 1,
      ports: {
        8: { vlan_mode: "enabled", vlan_receive: "any", default_vlan: 40 },
        5: { enabled: false },
      },
      vlans: [{ id: 100, members: [8] }],
    });
    const plan = planSwitchConfig(config, vlanOneSwitch());
    expect(plan.warnings).toContain("Port 5 has a link and would be disabled.");
    expect(
      plan.warnings.some((w) => w.startsWith("Port 8 filters VLANs with default VLAN 40")),
    ).toBe(true);
  });

  it("changes only the VLAN fields the document names", () => {
    const seeded = factory();
    seeded["vlan.b"] = parseWireBlob(
      "[{vid:0x0064,nm:'4d474d54',piso:0x00,lrn:0x01,mrr:0x00,igmp:0x01,mbr:0x000080}]",
    );
    const plan = planSwitchConfig(
      parseSwitchConfig({ version: 1, vlans: [{ id: 100, members: [8, 17] }] }),
      seeded,
    );
    expect(changesOf(plan, "vlan.b").map((c) => c.setting)).toEqual(["members"]);
    const rows = decodeEndpoint("vlan.b", plan.endpoints[0].blob ?? "", 18) as Record<
      string,
      unknown
    >[];
    expect(rows[0]).toMatchObject({ name: "MGMT", igmp: true, port_isolation: false });
  });

  it("allows a secret reference only in snmp.community", () => {
    expect(() =>
      parseSwitchConfig({ version: 1, system: { identity: "${SNMP_COMMUNITY}" } }, ENV),
    ).toThrowError(expect.objectContaining({ code: "SWOS_CONFIG_SECRET_NOT_ALLOWED" }));
  });

  it("never echoes a secret in a validation error", () => {
    let message = "";
    try {
      parseSwitchConfig(
        {
          version: 1,
          ports: { 1: { vlan_mode: "${SNMP_COMMUNITY}" } },
          snmp: { community: "${SNMP_COMMUNITY}" },
        },
        ENV,
      );
    } catch (err) {
      message = JSON.stringify(err) + String(err);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("s3cret");
  });

  it("refuses port 0 and port keys with a leading zero", () => {
    for (const key of ["0", "01"]) {
      expect(
        () => parseSwitchConfig({ version: 1, ports: { [key]: { name: "x" } } }),
        key,
      ).toThrowError(expect.objectContaining({ code: "SWOS_CONFIG_INVALID" }));
    }
  });

  it("refuses a CIDR without prefix bits and names with surrounding spaces", () => {
    expect(() =>
      parseSwitchConfig({ version: 1, system: { allow_from: "192.168.88.0/" } }),
    ).toThrowError(expect.objectContaining({ code: "SWOS_CONFIG_INVALID" }));
    expect(() => parseSwitchConfig({ version: 1, ports: { 1: { name: "desk " } } })).toThrowError(
      expect.objectContaining({ code: "SWOS_CONFIG_INVALID" }),
    );
  });

  it("unions two VLAN tables by id and members", () => {
    const current = parseWireBlob(
      "[{vid:0x0064,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000001}," +
        "{vid:0x00c8,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000002}]",
    );
    const target = parseWireBlob(
      "[{vid:0x0064,nm:'4f4c44',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x020000}," +
        "{vid:0x0190,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000004}]",
    );
    const rows = decodeEndpoint("vlan.b", unionVlanBlob(current, target), 18) as Record<
      string,
      unknown
    >[];
    expect(rows.map((r) => r.vid)).toEqual([100, 200, 400]);
    expect(rows[0].name).toBe("OLD");
    const ports = (rows[0].members as boolean[]).flatMap((on, i) => (on ? [i + 1] : []));
    expect(ports).toEqual([1, 18]);
  });
});

describe("port speed and auto-negotiation", () => {
  it("forces an SFP+ cage to 1G by clearing its auto-negotiation bit and setting its speed", () => {
    const config = parseSwitchConfig({
      version: 1,
      ports: { 17: { auto_negotiation: false, speed: "1G" } },
    });
    const plan = planSwitchConfig(config, factory());
    expect(plan.writes.map((w) => w.endpoint)).toEqual(["link.b"]);
    expect(changesOf(plan, "link.b").map((c) => [c.setting, c.port, c.from, c.to])).toEqual([
      ["auto_negotiation", 17, true, false],
      ["speed", 17, "10G", "1G"],
    ]);
    const before = factory()["link.b"] as Record<string, unknown>;
    const after = parseWireBlob(plan.writes[0].blob) as Record<string, unknown>;
    expect(after.an).toBe("0x02ffff");
    expect((after.spdc as string[])[16]).toBe("0x02");
    for (const key of Object.keys(before)) {
      if (key === "an" || key === "spdc") continue;
      expect(after[key], key).toEqual(before[key]);
    }
    const again = planSwitchConfig(config, applied(factory(), plan));
    expect(again.writes).toEqual([]);
  });

  it("warns when the negotiation of a linked port changes, not of an unlinked one", () => {
    const linked = planSwitchConfig(
      parseSwitchConfig({ version: 1, ports: { 17: { auto_negotiation: false, speed: "1G" } } }),
      factory(),
    );
    expect(linked.warnings).toEqual([
      "Port 17 has a link and its negotiation would change; the link drops and may not come back.",
    ]);
    const unlinked = planSwitchConfig(
      parseSwitchConfig({ version: 1, ports: { 18: { auto_negotiation: false, speed: "1G" } } }),
      factory(),
    );
    expect(unlinked.warnings).toEqual([]);
  });

  it("needs auto_negotiation: false next to a forced speed or duplex", () => {
    for (const port of [
      { speed: "1G" },
      { auto_negotiation: true, speed: "1G" },
      { full_duplex: true },
    ]) {
      expect(
        () => parseSwitchConfig({ version: 1, ports: { 17: port } }),
        JSON.stringify(port),
      ).toThrowError(/auto_negotiation: false/);
    }
  });

  it("refuses speeds a port type cannot be forced to", () => {
    expect(() =>
      planSwitchConfig(
        parseSwitchConfig({ version: 1, ports: { 4: { auto_negotiation: false, speed: "1G" } } }),
        factory(),
      ),
    ).toThrowError(/Port 4 is a copper port and cannot be forced to 1G/);
    expect(() =>
      planSwitchConfig(
        parseSwitchConfig({
          version: 1,
          ports: { 18: { auto_negotiation: false, speed: "100M" } },
        }),
        factory(),
      ),
    ).toThrowError(/Port 18 is an SFP\+ cage and cannot be forced to 100M/);
  });

  it("forces a copper port to 100M half duplex", () => {
    const plan = planSwitchConfig(
      parseSwitchConfig({
        version: 1,
        ports: { 4: { auto_negotiation: false, speed: "100M", full_duplex: false } },
      }),
      factory(),
    );
    const link = decodeEndpoint("link.b", plan.writes[0].blob, 18) as Record<string, unknown[]>;
    expect([link.auto_neg[3], link.manual_speed[3], link.manual_duplex[3]]).toEqual([
      false,
      "100M",
      false,
    ]);
    expect(link.auto_neg[4]).toBe(true);
  });
});

describe("isolation, storm control, flood control and LAG", () => {
  it("writes a port's isolation row, leaving out the port itself", () => {
    const plan = planSwitchConfig(
      parseSwitchConfig({ version: 1, ports: { 5: { forward_to: [5, 1, 2] } } }),
      factory(),
    );
    const fwd = decodeEndpoint("fwd.b", plan.writes[0].blob, 18) as Record<string, boolean[]>;
    expect(fwd.isolation_p5.flatMap((on, i) => (on ? [i + 1] : []))).toEqual([1, 2]);
    expect(fwd.isolation_p4.filter(Boolean)).toHaveLength(17);
    expect(plan.warnings).toEqual([]);
  });

  it("warns when a linked port would stop forwarding to another linked port", () => {
    const plan = planSwitchConfig(
      parseSwitchConfig({ version: 1, ports: { 1: { forward_to: [2, 3] } } }),
      factory(),
    );
    expect(plan.warnings).toEqual([
      "Port 1 has a link and would stop forwarding to linked port(s) 17.",
    ]);
  });

  it("sets storm control and flood control per port", () => {
    const plan = planSwitchConfig(
      parseSwitchConfig({
        version: 1,
        ports: {
          9: { storm_rate: 5, limit_unknown_unicast: true, flood_unknown_multicast: false },
        },
      }),
      factory(),
    );
    const fwd = decodeEndpoint("fwd.b", plan.writes[0].blob, 18) as Record<string, unknown[]>;
    expect([fwd.storm_rate[8], fwd.limit_unknown_ucast[8], fwd.flood_unknown_mcast[8]]).toEqual([
      5,
      true,
      false,
    ]);
    expect(fwd.storm_rate[9]).toBe(100);
  });

  it("writes LAG mode and group after the link settings, and warns for a linked port", () => {
    const plan = planSwitchConfig(
      parseSwitchConfig({
        version: 1,
        ports: {
          1: { name: "lag-a", lag_mode: "static", lag_group: 1 },
          2: { lag_mode: "static", lag_group: 1 },
        },
      }),
      { ...factory(), "lacp.b": wire(FULL, "lacp.b") },
    );
    expect(plan.writes.map((w) => w.endpoint)).toEqual(["link.b", "lacp.b"]);
    const lacp = decodeEndpoint("lacp.b", plan.writes[1].blob, 18) as Record<string, unknown[]>;
    expect([lacp.mode[0], lacp.group[0], lacp.mode[2]]).toEqual(["static", 1, "passive"]);
    expect(plan.warnings).toEqual([
      "Port 1 has a link and its link aggregation would change; it stops forwarding until the other end matches.",
    ]);
  });

  it("refuses storm control and LAG on SwOS Lite, whose encoding differs", () => {
    const lite: CurrentBlobs = {
      "sys.b": wire(LITE, "sys.b"),
      "link.b": wire(LITE, "link.b"),
      "fwd.b": wire(LITE, "fwd.b"),
      "lacp.b": wire(LITE, "lacp.b"),
    };
    for (const port of [{ storm_rate: 10 }, { lag_mode: "active" }]) {
      expect(
        () => planSwitchConfig(parseSwitchConfig({ version: 1, ports: { 1: port } }), lite),
        JSON.stringify(port),
      ).toThrowError(expect.objectContaining({ code: "SWOS_SETTING_UNSUPPORTED" }));
    }
  });
});

describe("what reaches the logs", () => {
  it("redacts a written-out community in a text config and in an object config", () => {
    const text = "version: 1\nsnmp:\n  enabled: true\n  community: s3cr3t-c0mmunity\n";
    expect(redactConfigParam(text)).toBe(
      "version: 1\nsnmp:\n  enabled: true\n  community: <redacted>\n",
    );
    const referenced = "version: 1\nsnmp:\n  community: ${SNMP_COMMUNITY}\n";
    expect(redactConfigParam(referenced)).toBe(referenced);
    expect(
      redactConfigParam({ version: 1, snmp: { enabled: true, community: "s3cr3t-c0mmunity" } }),
    ).toEqual({ version: 1, snmp: { enabled: true, community: "<redacted>" } });
    const ref = { version: 1, snmp: { community: "${SNMP_COMMUNITY}" } };
    expect(redactConfigParam(ref)).toEqual(ref);
    expect(redactConfigParam({ version: 1, ports: {} })).toEqual({ version: 1, ports: {} });
  });

  it("reports a YAML error by position, without quoting the source line", () => {
    const broken = "version: 1\nsnmp:\n  community: [s3cr3t-c0mmunity\n";
    let message = "";
    try {
      parseSwitchConfig(broken);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not valid YAML \(line \d+, column \d+\)/);
    expect(message).not.toContain("s3cr3t");
  });
});

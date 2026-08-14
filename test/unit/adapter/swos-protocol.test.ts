import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseBlob,
  parseWireBlob,
  dumpBlob,
  decodeEndpoint,
  encodeLike,
  toWireHex,
} from "../../../src/adapter/swos-protocol.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures/swos");

const captures: Record<string, string> = {};
for (const name of readdirSync(FIXTURES)) {
  // Real blobs end in .b; !stats.b.sample2 is a second capture of the same endpoint
  if (name.endsWith(".b") || name.endsWith(".sample2")) {
    captures[name] = readFileSync(join(FIXTURES, name), "utf8");
  }
}

describe("SwOS codec", () => {
  it("parses every real capture fixture", () => {
    const names = Object.keys(captures);
    expect(names.length).toBeGreaterThan(10);
    for (const [name, raw] of Object.entries(captures)) {
      expect(() => parseBlob(raw), name).not.toThrow();
    }
  });

  it("round-trips parse -> dump -> parse without value changes", () => {
    for (const [name, raw] of Object.entries(captures)) {
      const first = parseBlob(raw);
      const second = parseBlob(dumpBlob(first));
      expect(second, name).toEqual(first);
    }
  });

  it("round-trips the wire form byte-for-byte", () => {
    // Writes re-POST the whole blob, so an untouched capture must serialize
    // back to the exact bytes the device sent — padding included.
    for (const [name, raw] of Object.entries(captures)) {
      expect(dumpBlob(parseWireBlob(raw)), name).toBe(raw.trim());
    }
  });

  it("keeps hex tokens verbatim in the wire form", () => {
    const wire = parseWireBlob("{i01:0x00000000,i02:[0x0001,0x00]}") as Record<string, unknown>;
    expect(wire.i01).toBe("0x00000000");
    expect(wire.i02).toEqual(["0x0001", "0x00"]);
  });

  it("encodeLike pads a new value to the width it replaces", () => {
    expect(encodeLike(2, "0x00000000")).toBe("0x00000002");
    expect(encodeLike(2, "0x00")).toBe("0x02");
    expect(encodeLike(1023, "0x00")).toBe("0x03ff");
    expect(encodeLike(2, undefined)).toBe("0x02");
  });

  it("refuses to encode values that have no wire representation", () => {
    // toString(16) would yield "-1" / "Infinity", i.e. the malformed tokens
    // "0x-1" and "0xInfinity" — POSTed as part of a whole-blob write.
    for (const bad of [-1, 1.5, Infinity, NaN, 2 ** 40]) {
      expect(() => toWireHex(bad), String(bad)).toThrowError(
        expect.objectContaining({ code: "SWOS_VALUE_OUT_OF_RANGE" }),
      );
    }
    expect(toWireHex(0)).toBe("0x00");
    expect(toWireHex(0xffffffff)).toBe("0xffffffff");
  });

  it("decodes sys.b into readable values", () => {
    const sys = decodeEndpoint("sys.b", captures["sys.b"]) as Record<string, unknown>;
    expect(sys.identity).toBe("core-switch");
    expect(sys.model).toBe("CSS610-8P-2S+");
    expect(sys.serial).toBe("SWTEST00001");
    expect(sys.version).toBe("2.21");
    expect(sys.mac).toBe("02:00:00:00:00:1E");
    expect(sys.ip).toBe("10.10.10.5");
    expect(sys.addr_acq).toBe("DHCP only");
    expect(sys.uptime).toBe(0x2254);
    expect(sys.psu1_voltage).toBeCloseTo(28.1);
    expect(sys.psu2_voltage).toBeCloseTo(54.0);
    expect(sys.cpu_temp).toBe(0x46);
    expect(sys.power_consumption).toBeCloseTo(18.9);
  });

  it("decodes link.b per-port fields as arrays of length 10", () => {
    const link = decodeEndpoint("link.b", captures["link.b"]) as Record<string, unknown>;
    expect(link.enabled).toEqual(Array(10).fill(true));
    expect(link.link).toEqual([true, true, true, false, true, true, true, true, true, true]);
    expect(link.speed).toEqual(["1G", "1G", "1G", "down", "1G", "100M", "1G", "1G", "10G", "10G"]);
    expect(link.name).toEqual([
      "p1_uplink-a",
      "p2_uplink-b",
      "p3_switch",
      "p4_camera",
      "p5_ap-hall",
      "p6_workshop",
      "p7_lag-nas-1",
      "p8_lag-nas-2",
      "sfp+1_nas",
      "sfp+2_server",
    ]);
  });

  it("decodes sys.b per-port bitmasks even though the blob has no arrays", () => {
    // sys.b is entirely scalar, so the port count has to come from the widest
    // bitmask (0x03ff -> 10 ports) rather than from an array length.
    const sys = decodeEndpoint("sys.b", captures["sys.b"]) as Record<string, unknown>;
    expect(sys.allow_from_ports).toEqual(Array(10).fill(true));
    expect(sys.dhcp_trusted_ports).toEqual(Array(10).fill(true));
    expect(sys.discovery_protocol).toEqual(Array(10).fill(true));
  });

  it("decodes record endpoints without duplicating known keys into _raw", () => {
    const records = decodeEndpoint("host.b", "[{i01:'020000000001',i02:0x01,i09:0x05}]") as Record<
      string,
      unknown
    >[];
    expect(records[0].mac).toBe("02:00:00:00:00:01");
    expect(records[0].port).toBe(1);
    expect(records[0]._raw).toEqual({ i09: 5 });
  });

  it("decodes the learned-MAC table", () => {
    const hosts = decodeEndpoint("!dhost.b", captures["!dhost.b"]) as Record<string, unknown>[];
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts[0].mac).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  });

  it("decodes poe.b per-port state into the PoE state enum", () => {
    const poe = decodeEndpoint("poe.b", captures["poe.b"]) as Record<string, unknown>;
    expect(poe.out).toEqual(["off", "off", "auto", "auto", "auto", "auto", "auto", "off", "auto", "auto"]);
    expect(poe.state).toEqual([
      "disabled",
      "disabled",
      "powered_on",
      "waiting_for_load",
      "powered_on",
      "waiting_for_load",
      "powered_on",
      "disabled",
      "none",
      "none",
    ]);
    expect(poe.controller).toBe("7W8WBG10AEH");
    expect(poe.power).toEqual([0, 0, 8.2, 0, 6.3, 0, 4.4, 0, 0, 0]);
  });

  it("decodes stats.b generically per port with metric aliases", () => {
    const stats = decodeEndpoint("!stats.b", captures["!stats.b"]) as Record<string, unknown>;
    const port1 = stats["1"] as Record<string, unknown>;
    const scalars = stats["_scalars"] as Record<string, unknown>;
    expect(port1).toBeDefined();
    expect(port1.rx_bytes).toBeTypeOf("number");
    expect(port1.tx_bytes).toBeTypeOf("number");
    expect(scalars).toBeTypeOf("object");
  });

  it("keeps unknown keys under _raw", () => {
    const sys = decodeEndpoint("sys.b", captures["sys.b"]) as Record<string, unknown>;
    const raw = sys._raw as Record<string, unknown>;
    // i21/i23/i24 are not in the sys schema -> preserved raw
    expect(raw).toHaveProperty("i21");
  });

  it("decodes both stats.b captures with identical shape", () => {
    const first = decodeEndpoint("!stats.b", captures["!stats.b"]) as Record<string, unknown>;
    const second = decodeEndpoint("!stats.b", captures["!stats.b.sample2"]) as Record<string, unknown>;
    expect(Object.keys(second)).toEqual(Object.keys(first));
    for (const port of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
      expect(second[port]).toBeDefined();
    }
  });

  it("stats.b counters increase monotonically between captures", () => {
    // sample2 is the earlier capture; !stats.b was taken seconds later and
    // every per-port counter has grown (counters never decrease).
    const first = decodeEndpoint("!stats.b", captures["!stats.b.sample2"]) as Record<string, unknown>;
    const second = decodeEndpoint("!stats.b", captures["!stats.b"]) as Record<string, unknown>;
    for (const port of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
      const a = first[port] as Record<string, unknown>;
      const b = second[port] as Record<string, unknown>;
      expect(Number(b.rx_bytes)).toBeGreaterThanOrEqual(Number(a.rx_bytes));
      expect(Number(b.tx_bytes)).toBeGreaterThanOrEqual(Number(a.tx_bytes));
    }
  });
});

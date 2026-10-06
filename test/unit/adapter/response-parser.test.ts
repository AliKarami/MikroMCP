import { describe, it, expect } from "vitest";
import {
  parseRouterOSValue,
  parseRecord,
  parseRecords,
  isTrue,
  sameValue,
  normalizeWireValue,
  lastSection,
} from "../../../src/adapter/response-parser.js";

describe("isTrue", () => {
  it("accepts parsed booleans and raw strings", () => {
    expect(isTrue(true)).toBe(true);
    expect(isTrue("true")).toBe(true);
    expect(isTrue("yes")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTrue(false)).toBe(false);
    expect(isTrue("false")).toBe(false);
    expect(isTrue("no")).toBe(false);
    expect(isTrue(undefined)).toBe(false);
    expect(isTrue(null)).toBe(false);
    expect(isTrue(0)).toBe(false);
    expect(isTrue("")).toBe(false);
  });
});

describe("parseRouterOSValue", () => {
  it("parses 'true' to boolean true", () => {
    expect(parseRouterOSValue("running", "true")).toBe(true);
  });

  it("parses 'false' to boolean false", () => {
    expect(parseRouterOSValue("disabled", "false")).toBe(false);
  });

  it("parses integer strings to numbers", () => {
    expect(parseRouterOSValue("mtu", "1500")).toBe(1500);
  });

  it("parses negative numbers", () => {
    expect(parseRouterOSValue("offset", "-5")).toBe(-5);
  });

  it("parses decimal numbers", () => {
    expect(parseRouterOSValue("load", "3.14")).toBe(3.14);
  });

  it("keeps unsafe 64-bit integers as strings to avoid precision loss", () => {
    expect(parseRouterOSValue("rx-byte", "12345678901234567890")).toBe("12345678901234567890");
    expect(parseRouterOSValue("rx-byte", "9007199254740993")).toBe("9007199254740993");
  });

  it("keeps free-text fields as strings", () => {
    expect(parseRouterOSValue("comment", "0123")).toBe("0123");
    expect(parseRouterOSValue("comment", "true")).toBe("true");
    expect(parseRouterOSValue("text", "1.50")).toBe("1.50");
    expect(parseRouterOSValue("text", "42")).toBe("42");
  });

  it("keeps decimal versions and firmware as strings", () => {
    expect(parseRouterOSValue("latest-version", "7.20")).toBe("7.20");
    expect(parseRouterOSValue("current-firmware", "7.10")).toBe("7.10");
    expect(parseRouterOSValue("version", "7.10")).toBe("7.10");
  });

  it("still parses an integer protocol version (VRRP, IGMP) as a number", () => {
    expect(parseRouterOSValue("version", "3")).toBe(3);
    expect(parseRouterOSValue("igmp-version", "2")).toBe(2);
  });

  it("still parses decimals outside version fields", () => {
    expect(parseRouterOSValue("bad-blocks", "0.1")).toBe(0.1);
  });

  it("keeps .id values as strings", () => {
    expect(parseRouterOSValue(".id", "*A")).toBe("*A");
    expect(parseRouterOSValue(".id", "*1")).toBe("*1");
  });

  it("keeps duration strings as strings", () => {
    expect(parseRouterOSValue("uptime", "1d2h3m4s")).toBe("1d2h3m4s");
    expect(parseRouterOSValue("uptime", "5m30s")).toBe("5m30s");
    expect(parseRouterOSValue("uptime", "2w1d")).toBe("2w1d");
  });

  it("keeps IP addresses as strings", () => {
    expect(parseRouterOSValue("address", "192.168.1.1/24")).toBe("192.168.1.1/24");
  });

  it("keeps MAC addresses as strings", () => {
    expect(parseRouterOSValue("mac-address", "00:11:22:33:44:55")).toBe("00:11:22:33:44:55");
  });

  it("keeps regular strings as strings", () => {
    expect(parseRouterOSValue("name", "ether1")).toBe("ether1");
  });
});

describe("parseRecord", () => {
  it("parses all values in a record", () => {
    const raw = {
      ".id": "*1",
      name: "ether1",
      mtu: "1500",
      running: "true",
      disabled: "false",
      type: "ether",
    };

    const parsed = parseRecord(raw);

    expect(parsed).toEqual({
      ".id": "*1",
      name: "ether1",
      mtu: 1500,
      running: true,
      disabled: false,
      type: "ether",
    });
  });
});

describe("parseRecords", () => {
  it("parses an array of records", () => {
    const raw = [
      { ".id": "*1", name: "ether1", running: "true" },
      { ".id": "*2", name: "ether2", running: "false" },
    ];

    const parsed = parseRecords(raw);

    expect(parsed).toEqual([
      { ".id": "*1", name: "ether1", running: true },
      { ".id": "*2", name: "ether2", running: false },
    ]);
  });

  it("handles empty array", () => {
    expect(parseRecords([])).toEqual([]);
  });
});

describe("sameValue", () => {
  it("matches a parsed number against the desired number or wire string", () => {
    expect(sameValue(10, 10)).toBe(true);
    expect(sameValue(10, "10")).toBe(true);
    expect(sameValue("10", 10)).toBe(true);
  });

  it("rejects differing values", () => {
    expect(sameValue(10, 20)).toBe(false);
    expect(sameValue("ether1", "ether2")).toBe(false);
  });

  it("treats a missing record field as not matching", () => {
    expect(sameValue(undefined, "10")).toBe(false);
  });
});

describe("normalizeWireValue", () => {
  it("maps RouterOS booleans to true/false", () => {
    expect(normalizeWireValue(true)).toBe("true");
    expect(normalizeWireValue("yes")).toBe("true");
    expect(normalizeWireValue("no")).toBe("false");
  });

  it("stringifies numbers and maps a missing value to an empty string", () => {
    expect(normalizeWireValue(443)).toBe("443");
    expect(normalizeWireValue(undefined)).toBe("");
    expect(normalizeWireValue(null)).toBe("");
  });
});

describe("lastSection", () => {
  it("keeps only the records of the highest .section", () => {
    expect(
      lastSection([
        { ".section": "0", address: "a" },
        { ".section": "1", address: "b" },
        { ".section": "1", address: "c" },
      ]),
    ).toEqual([
      { ".section": "1", address: "b" },
      { ".section": "1", address: "c" },
    ]);
  });

  it("compares sections numerically", () => {
    const records = [{ ".section": "9" }, { ".section": "10" }];
    expect(lastSection(records)).toEqual([{ ".section": "10" }]);
  });

  it("returns every record when none carries a .section", () => {
    expect(lastSection([{ a: "1" }, { a: "2" }])).toEqual([{ a: "1" }, { a: "2" }]);
  });

  it("does not depend on the order of the records", () => {
    expect(
      lastSection([
        { ".section": "2", a: "x" },
        { ".section": "1", a: "y" },
      ]),
    ).toEqual([{ ".section": "2", a: "x" }]);
  });

  it("treats a missing or non-numeric .section as section 0 instead of emptying the result", () => {
    expect(lastSection([{ ".section": "x", a: "1" }])).toEqual([{ ".section": "x", a: "1" }]);
    expect(lastSection([{ a: "untagged" }, { ".section": "0", a: "tagged" }])).toEqual([
      { a: "untagged" },
      { ".section": "0", a: "tagged" },
    ]);
    expect(lastSection([{ a: "untagged" }, { ".section": "1", a: "final" }])).toEqual([
      { ".section": "1", a: "final" },
    ]);
  });

  it("wraps a single record and handles an empty result", () => {
    expect(lastSection({ a: "1" })).toEqual([{ a: "1" }]);
    expect(lastSection([])).toEqual([]);
    expect(lastSection(undefined)).toEqual([]);
  });
});

describe("parseRecord - version fields of real router records", () => {
  // Read from an RB5009 and a NetMetal ax on RouterOS 7.24.2 (get_system_status,
  // list_packages, get_upgrade_status, 2026-10-06), written back as REST wire strings.
  it("keeps minimum-version of /system/resource a string, like a multi-dot version", () => {
    const rb5009 = parseRecord({
      "architecture-name": "arm64",
      "bad-blocks": "0",
      "board-name": "RB5009UPr+S+",
      "cpu-count": "4",
      "cpu-load": "1",
      "minimum-version": "7.8",
      uptime: "3w3d11h1m38s",
      version: "7.24.2 (stable)",
    });
    expect(rb5009["minimum-version"]).toBe("7.8");
    expect(rb5009["cpu-count"]).toBe(4);
    expect(rb5009.version).toBe("7.24.2 (stable)");

    const netmetal = parseRecord({ "minimum-version": "7.14.2", "cpu-count": "2" });
    expect(netmetal["minimum-version"]).toBe("7.14.2");
  });

  it("keeps routerboard firmware fields strings", () => {
    const rb = parseRecord({
      "current-firmware": "7.24.2",
      "firmware-type": "70x0",
      "minimum-firmware": "7.19.6",
      model: "RB5009UPr+S+",
      routerboard: "true",
      "upgrade-firmware": "7.24.2",
    });
    expect(rb).toMatchObject({
      "current-firmware": "7.24.2",
      "minimum-firmware": "7.19.6",
      routerboard: true,
    });
  });

  it("keeps a release ending in 0 intact in /system/package/update", () => {
    // Derived: RB5009 reported installed 7.24.2 and latest 7.24.4; latest-version is set
    // to 7.20, a real release, which a number would show as 7.2.
    const update = parseRecord({
      channel: "stable",
      "installed-version": "7.24.2",
      "latest-version": "7.20",
      status: "New version is available",
    });
    expect(update["latest-version"]).toBe("7.20");
    expect(update["installed-version"]).toBe("7.24.2");
  });

  it("keeps a package version string and parses its size", () => {
    const pkg = parseRecord({
      ".id": "*1",
      "build-time": "2026-09-03 09:57:14",
      disabled: "false",
      name: "routeros",
      size: "13922573",
      version: "7.24.2",
    });
    expect(pkg).toMatchObject({ version: "7.24.2", size: 13922573, disabled: false });
  });
});

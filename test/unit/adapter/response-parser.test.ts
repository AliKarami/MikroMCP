import { describe, it, expect } from "vitest";
import { parseRouterOSValue, parseRecord, parseRecords } from "../../../src/adapter/response-parser.js";

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

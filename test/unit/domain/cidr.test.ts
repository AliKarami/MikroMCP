import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  canonicalIpv6,
  cidrFamily,
  cidrSchema,
  ipCidrSchema,
  ipv6CidrSchema,
  ipv6HostBits,
  ipv6NetworkBits,
  normalizeIpv6Cidr,
  parseIpv6Cidr,
} from "../../../src/domain/tools/cidr.js";

describe("cidrSchema", () => {
  it("accepts valid CIDR", () => {
    expect(cidrSchema.parse("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(cidrSchema.parse("192.168.1.0/24")).toBe("192.168.1.0/24");
    expect(cidrSchema.parse("0.0.0.0/0")).toBe("0.0.0.0/0");
  });

  it("auto-appends /32 for bare IPs", () => {
    expect(cidrSchema.parse("10.0.0.1")).toBe("10.0.0.1/32");
  });

  it("rejects octets > 255", () => {
    expect(() => cidrSchema.parse("256.0.0.1/24")).toThrow();
    expect(() => cidrSchema.parse("999.999.999.999/32")).toThrow();
  });

  it("rejects prefix > 32", () => {
    expect(() => cidrSchema.parse("10.0.0.0/33")).toThrow();
    expect(() => cidrSchema.parse("10.0.0.0/99")).toThrow();
  });

  it("rejects non-numeric octets", () => {
    expect(() => cidrSchema.parse("abc.def.ghi.jkl/24")).toThrow();
  });
});

describe("canonicalIpv6", () => {
  it.each([
    ["2001:DB8:0::1", "2001:db8::1"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["::", "::"],
    ["::1", "::1"],
    ["fe80::", "fe80::"],
    ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
    // RFC 5952 4.2.3: the first of two equal zero runs is compressed.
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    // RFC 5952 4.2.2: a lone zero group stays a 0.
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["::ffff:192.0.2.1", "::ffff:c000:201"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalIpv6(input)).toBe(expected);
  });

  it("returns undefined for non-IPv6 input", () => {
    expect(canonicalIpv6("192.0.2.1")).toBeUndefined();
    expect(canonicalIpv6("1::2::3")).toBeUndefined();
    expect(canonicalIpv6("fe80::1%ether1")).toBeUndefined();
    expect(canonicalIpv6("ether1")).toBeUndefined();
  });
});

describe("parseIpv6Cidr", () => {
  it("parses and canonicalises address and prefix", () => {
    const cidr = parseIpv6Cidr("2001:DB8:0::1/64");
    expect(cidr.address).toBe("2001:db8::1");
    expect(cidr.prefix).toBe(64);
    expect(cidr.value).toBe((0x20010db8n << 96n) | 1n);
  });

  it("requires a prefix unless a default is given", () => {
    expect(() => parseIpv6Cidr("2001:db8::1")).toThrow(/prefix length/);
    expect(parseIpv6Cidr("2001:db8::1", 128).prefix).toBe(128);
  });

  it("rejects prefixes outside 0-128", () => {
    expect(() => parseIpv6Cidr("2001:db8::/129")).toThrow(/0–128/);
    expect(() => parseIpv6Cidr("2001:db8::/-1")).toThrow(/0–128/);
    expect(() => parseIpv6Cidr("2001:db8::/")).toThrow(/0–128/);
    expect(parseIpv6Cidr("::/0").prefix).toBe(0);
  });

  it("splits network and host bits at the prefix", () => {
    const cidr = parseIpv6Cidr("2001:db8:1:2::abcd/64");
    expect(ipv6NetworkBits(cidr)).toBe(parseIpv6Cidr("2001:db8:1:2::/64").value);
    expect(ipv6HostBits(cidr)).toBe(0xabcdn);
    expect(ipv6HostBits(parseIpv6Cidr("::1/128"))).toBe(0n);
    expect(ipv6NetworkBits(parseIpv6Cidr("2001:db8::1/0"))).toBe(0n);
  });
});

describe("normalizeIpv6Cidr", () => {
  it("canonicalises RouterOS values and returns undefined for anything else", () => {
    expect(normalizeIpv6Cidr("2001:0DB8::0001/64")).toBe("2001:db8::1/64");
    expect(normalizeIpv6Cidr("10.0.0.0/8")).toBeUndefined();
    expect(normalizeIpv6Cidr(undefined)).toBeUndefined();
    expect(normalizeIpv6Cidr(42)).toBeUndefined();
  });
});

describe("ipv6CidrSchema", () => {
  it("normalises to canonical form", () => {
    expect(ipv6CidrSchema.parse("2001:DB8:0::1/64")).toBe("2001:db8::1/64");
  });

  it("rejects a bare address, IPv4 and garbage", () => {
    expect(() => ipv6CidrSchema.parse("2001:db8::1")).toThrow();
    expect(() => ipv6CidrSchema.parse("192.0.2.1/24")).toThrow();
    expect(() => ipv6CidrSchema.parse("2001:db8::zz/64")).toThrow();
  });
});

describe("ipCidrSchema", () => {
  it("keeps IPv4 behaviour, /32 for a bare address", () => {
    expect(ipCidrSchema.parse("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(ipCidrSchema.parse("10.0.0.1")).toBe("10.0.0.1/32");
    expect(() => ipCidrSchema.parse("10.0.0.0/33")).toThrow();
  });

  it("accepts IPv6, /128 for a bare address", () => {
    expect(ipCidrSchema.parse("2001:DB8::/32")).toBe("2001:db8::/32");
    expect(ipCidrSchema.parse("2001:db8::1")).toBe("2001:db8::1/128");
    expect(ipCidrSchema.parse("::/0")).toBe("::/0");
    expect(() => ipCidrSchema.parse("2001:db8::/200")).toThrow();
  });

  it("reports the family of a parsed CIDR", () => {
    expect(cidrFamily(ipCidrSchema.parse("10.0.0.0/8"))).toBe(4);
    expect(cidrFamily(ipCidrSchema.parse("2001:db8::/32"))).toBe(6);
  });
});

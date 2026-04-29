import { describe, it, expect } from "vitest";
import { z } from "zod";
import { cidrSchema } from "../../../src/domain/tools/cidr.js";

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

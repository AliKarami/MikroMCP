import { describe, it, expect } from "vitest";
import { sameRuleValue } from "../../../src/domain/tools/rule-match.js";

describe("sameRuleValue", () => {
  it("compares parsed numbers with requested strings", () => {
    expect(sameRuleValue("dst-port", 53, "53")).toBe(true);
    expect(sameRuleValue("dst-port", 53, "54")).toBe(false);
  });

  it("treats a missing field as empty", () => {
    expect(sameRuleValue("in-interface", undefined, undefined)).toBe(true);
    expect(sameRuleValue("in-interface", "", undefined)).toBe(true);
    expect(sameRuleValue("in-interface", "ether1", undefined)).toBe(false);
  });

  it("ignores a host /32 mask on address fields", () => {
    expect(sameRuleValue("dst-address", "192.168.1.1", "192.168.1.1/32")).toBe(true);
    expect(sameRuleValue("to-addresses", "10.0.0.5/32", "10.0.0.5")).toBe(true);
    expect(sameRuleValue("src-address", "!10.0.0.5", "!10.0.0.5/32")).toBe(true);
    expect(sameRuleValue("src-address", "10.0.0.0/24", "10.0.0.0/32")).toBe(false);
  });

  it("treats protocol all as no protocol", () => {
    expect(sameRuleValue("protocol", undefined, "all")).toBe(true);
    expect(sameRuleValue("protocol", "", "all")).toBe(true);
    expect(sameRuleValue("protocol", "tcp", "all")).toBe(false);
  });

  it("leaves /32 alone on non-address fields", () => {
    expect(sameRuleValue("comment", "x", "x/32")).toBe(false);
  });

  it("compares sets ignoring order and repeats", () => {
    expect(
      sameRuleValue(
        "connection-state",
        "established,related,untracked",
        "untracked,related,established",
      ),
    ).toBe(true);
    expect(sameRuleValue("connection-nat-state", "srcnat,dstnat", "dstnat,srcnat")).toBe(true);
    expect(sameRuleValue("connection-state", "established", "established,established")).toBe(true);
    expect(sameRuleValue("connection-state", "established", "established,related")).toBe(false);
  });

  it("respects whole-set negation", () => {
    expect(sameRuleValue("connection-nat-state", "!dstnat", "!dstnat")).toBe(true);
    expect(sameRuleValue("connection-nat-state", "!dstnat", "dstnat")).toBe(false);
    expect(sameRuleValue("connection-state", "!invalid", "invalid")).toBe(false);
  });

  // Known limits: values are compared as canonical strings, not as address sets.
  // These tests pin the current behavior; a change here should be deliberate.
  describe("known limits", () => {
    it("compares an address range only as written", () => {
      expect(sameRuleValue("src-address", "10.0.0.1-10.0.0.9", "10.0.0.1-10.0.0.9")).toBe(true);
      expect(sameRuleValue("src-address", "10.0.0.0-10.0.0.15", "10.0.0.0/28")).toBe(false);
    });

    it("strips /32 only at the end of an address list", () => {
      expect(sameRuleValue("to-addresses", "10.0.0.1/32,10.0.0.2", "10.0.0.1,10.0.0.2")).toBe(
        false,
      );
      expect(sameRuleValue("to-addresses", "10.0.0.1,10.0.0.2/32", "10.0.0.1,10.0.0.2")).toBe(true);
    });

    it("does not treat an IPv6 /128 as a bare host", () => {
      expect(sameRuleValue("dst-address", "2001:db8::1/128", "2001:db8::1")).toBe(false);
    });
  });

  describe("equivalence properties", () => {
    // For each property, every value in a group is equivalent to every other value
    // in that group and to no value in another group.
    const groups: Record<string, unknown[][]> = {
      "dst-port": [[53, "53"], ["54"], ["8000-8100"], [undefined, ""]],
      "dst-address": [
        ["192.168.1.1", "192.168.1.1/32"],
        ["192.168.1.0/24"],
        ["!192.168.1.1", "!192.168.1.1/32"],
        [undefined, ""],
      ],
      "connection-state": [
        ["established,related", "related,established", "established,related,related"],
        ["!established,related", "!related,established"],
        ["new"],
        [undefined, ""],
      ],
      disabled: [
        [true, "true", "yes"],
        [false, "false", "no"],
      ],
    };

    for (const [property, valueGroups] of Object.entries(groups)) {
      const all = valueGroups.flatMap((group, g) => group.map((value) => ({ value, g })));

      it(`${property}: reflexive`, () => {
        for (const { value } of all) expect(sameRuleValue(property, value, value)).toBe(true);
      });

      it(`${property}: symmetric and matches the grouping`, () => {
        for (const a of all) {
          for (const b of all) {
            const same = sameRuleValue(property, a.value, b.value);
            expect(same).toBe(sameRuleValue(property, b.value, a.value));
            expect(same).toBe(a.g === b.g);
          }
        }
      });
    }
  });
});

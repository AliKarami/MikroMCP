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
});

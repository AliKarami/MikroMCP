// ---------------------------------------------------------------------------
// MikroMCP - Rule field comparison (firewall, mangle, routing rules)
// ---------------------------------------------------------------------------

import { normalizeWireValue } from "../../adapter/response-parser.js";

/** Address fields: a host may be written as `10.0.0.1` or `10.0.0.1/32`. */
const ADDRESS_PROPERTIES: ReadonlySet<string> = new Set([
  "src-address",
  "dst-address",
  "to-addresses",
]);

/**
 * Set fields: comma-separated items where order and repeats do not matter; an
 * optional leading `!` negates the whole set.
 */
const SET_PROPERTIES: ReadonlySet<string> = new Set(["connection-state", "connection-nat-state"]);

function canonical(property: string, value: string): string {
  // `protocol=all` is the absence of a protocol match; RouterOS reports no protocol.
  if (property === "protocol" && value === "all") return "";
  if (ADDRESS_PROPERTIES.has(property)) return value.replace(/\/32$/, "");
  if (SET_PROPERTIES.has(property)) {
    const negated = value.startsWith("!");
    const items = new Set((negated ? value.slice(1) : value).split(",").filter(Boolean));
    return (negated ? "!" : "") + [...items].sort().join(",");
  }
  return value;
}

/**
 * Compare a rule field as stored by RouterOS with a requested value. The
 * response parser turns numeric strings into numbers (`dst-port: 53`), a
 * missing field equals an empty one, `protocol=all` equals no protocol, a host
 * `/32` mask is optional, and set fields ignore element order.
 */
export function sameRuleValue(property: string, stored: unknown, requested: unknown): boolean {
  return (
    canonical(property, normalizeWireValue(stored)) ===
    canonical(property, normalizeWireValue(requested))
  );
}

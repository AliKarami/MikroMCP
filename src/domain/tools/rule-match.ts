// ---------------------------------------------------------------------------
// MikroMCP - Rule field comparison (firewall, mangle, routing rules)
// ---------------------------------------------------------------------------

import { normalizeWireValue } from "../../adapter/response-parser.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

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

/**
 * IP protocol numbers RouterOS stores as names: a rule added with `protocol=6` reads
 * back as `tcp`. Read from RouterOS 7.24.2 for every number 0-255; the numbers not
 * listed are stored as numbers. The CHR integration test checks this table.
 */
export const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
  "1": "icmp",
  "2": "igmp",
  "3": "ggp",
  "4": "ipencap",
  "5": "st",
  "6": "tcp",
  "8": "egp",
  "12": "pup",
  "17": "udp",
  "20": "hmp",
  "22": "xns-idp",
  "27": "rdp",
  "29": "iso-tp4",
  "33": "dccp",
  "36": "xtp",
  "37": "ddp",
  "38": "idpr-cmtp",
  "41": "ipv6-encap",
  "43": "ipv6-route",
  "44": "ipv6-frag",
  "46": "rsvp",
  "47": "gre",
  "50": "ipsec-esp",
  "51": "ipsec-ah",
  "58": "icmpv6",
  "59": "ipv6-nonxt",
  "60": "ipv6-opts",
  "73": "rspf",
  "81": "vmtp",
  "89": "ospf",
  "94": "ipip",
  "97": "etherip",
  "98": "encap",
  "103": "pim",
  "112": "vrrp",
  "115": "l2tp",
  "132": "sctp",
  "136": "udp-lite",
};

/** The name RouterOS stores for a protocol given by name or number. */
export function protocolName(value: string): string {
  return PROTOCOL_NAMES[value] ?? value;
}

/**
 * Flag lists: comma-separated items, each optionally negated by its own `!`. RouterOS
 * reorders them (`!ack,syn` is stored as `syn,!ack`, CHR 7.23.2 and 7.24.2), so they
 * are compared in any order.
 */
const FLAG_PROPERTIES: ReadonlySet<string> = new Set(["tcp-flags"]);

function canonical(property: string, value: string): string {
  // `protocol=all` is the absence of a protocol match; RouterOS reports no protocol.
  if (property === "protocol") return value === "all" ? "" : protocolName(value);
  if (ADDRESS_PROPERTIES.has(property)) return value.replace(/\/32$/, "");
  if (SET_PROPERTIES.has(property)) {
    const negated = value.startsWith("!");
    const items = new Set((negated ? value.slice(1) : value).split(",").filter(Boolean));
    return (negated ? "!" : "") + [...items].sort().join(",");
  }
  if (FLAG_PROPERTIES.has(property)) {
    return [...new Set(value.split(",").filter(Boolean))].sort().join(",");
  }
  return value;
}

/**
 * Compare a rule field as stored by RouterOS with a requested value. The
 * response parser turns numeric strings into numbers (`dst-port: 53`), a
 * missing field equals an empty one, `protocol=all` equals no protocol and a
 * protocol number equals the name RouterOS stores for it, a host `/32` mask is optional, and set and flag fields ignore element order.
 */
export function sameRuleValue(property: string, stored: unknown, requested: unknown): boolean {
  return (
    canonical(property, normalizeWireValue(stored)) ===
    canonical(property, normalizeWireValue(requested))
  );
}

/**
 * The VALIDATION error for a `ruleAction` passed to remove, enable, or disable, where
 * it would not narrow which rule the call acts on.
 */
export function ruleActionAddOnly(
  action: string,
  ruleAction: string,
  suggestedAction: string,
): MikroMCPError {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code: "RULE_ACTION_ADD_ONLY",
    message: `ruleAction applies only to add, not to ${action}.`,
    details: { action, ruleAction },
    recoverability: { retryable: false, suggestedAction },
  });
}

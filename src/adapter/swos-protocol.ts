// ---------------------------------------------------------------------------
// MikroMCP - SwOS / SwOS Lite wire protocol
//
// Single source of truth for the reverse-engineered MikroTik SwitchOS ".b" API.
// Derived from a CSS610-8P-2S+ running SwOS Lite 2.21: the device's own
// engine.js plus live captures, which are committed as test fixtures under
// test/fixtures/swos/ and pinned by test/unit/adapter/swos-protocol.test.ts.
//
// Transport
//   * Plain HTTP GET/POST to http://<switch>/<tab>.b  (no TLS)
//   * HTTP Digest auth on every request (login/password)
//   * Reads:  GET  /link.b  -> blob
//   * Writes: POST /link.b  -> whole re-encoded blob (the web UI always writes
//     the entire endpoint, never a diff). Safe pattern: GET -> mutate -> POST.
//
// Wire format ("broken JSON")
//   * Unquoted bare keys:            {en:0x03ff, ...}
//   * Unquoted 0x hex values:        en:0x03ff
//   * Single-quoted hex strings:    nm:'6d657a7a...'
//   * Arrays of the above:          spdc:[0x02,0x02,...]
//   Decode: quote keys, ' -> ", 0xNN -> "0xNN".  Encode: reverse, drop spaces.
//
// Profiles
//   SwOS      (CSS326)     uses short mnemonic keys (en, nm, spdc, ...).
//   SwOS Lite (CSS610)     uses opaque iNN keys (i01, i0a, ...).
//   `keys` maps profile -> wire key; select_key picks whichever key is present
//   in the actual response, so one schema decodes both firmware families.
//
// The full-SwOS mnemonics are taken from the field declarations in the SwOS
// 2.18 web UI script of a CSS326-24G-2S+ (the CSS318 runs the same dialect).
// Where the two dialects encode a field differently (option lists, scale), the
// difference is declared per profile in `profiles`.
// ---------------------------------------------------------------------------

import { MikroMCPError, ErrorCategory } from "../domain/errors/error-types.js";

/**
 * Firmware key dialect. SwOS uses short mnemonics, SwOS Lite opaque `iNN` keys.
 * The two namespaces never collide, so the dialect is detected per field from
 * the blob itself rather than configured.
 */
export type SwosProfile = "swos" | "swos_lite";

export const Kind = {
  BOOL: "bool",
  STR: "str",
  OPTION: "option",
  MAC: "mac",
  IP: "ip",
  INT: "int",
  CHECKBOX: "checkbox",
  HEX: "hex",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

/** Encoding attributes a dialect may declare differently for the same field. */
export type ProfileOverride = Partial<
  Pick<Field, "kind" | "options" | "signed" | "bits" | "scale" | "unknown" | "note">
>;

export interface Field {
  name: string;
  keys: Partial<Record<SwosProfile, string>>;
  kind: Kind;
  options?: readonly string[];
  signed?: boolean;
  bits?: number;
  scale?: number;
  perPort?: boolean;
  unknown?: boolean;
  note?: string;
  profiles?: Partial<Record<SwosProfile, ProfileOverride>>;
}

/** Schema field constructor — every endpoint below is built from these. */
function f(
  name: string,
  keys: Partial<Record<SwosProfile, string>>,
  kind: Kind,
  opts: Partial<Field> = {},
): Field {
  return { name, keys, kind, ...opts };
}

export interface Endpoint {
  path: string;
  fields: Field[];
  isArray?: boolean;
  genericPerPort?: boolean;
  note?: string;
}

export type DecodedBlob = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Wire parser / serializer ("broken JSON")
// ---------------------------------------------------------------------------

const KEY_QUOTE = /([{,])([a-zA-Z][a-zA-Z0-9]*)/g;
const HEX_QUOTE = /(0x[0-9a-fA-F]+)/g;
const HEX_UNQUOTE = /"0x([0-9a-fA-F]+)"/g;
const KEY_UNQUOTE = /"([a-zA-Z][a-zA-Z0-9]*)":/g;
const HEX_TOKEN = /^0x[0-9a-fA-F]+$/;

/**
 * True for a raw wire hex token (`"0x03ff"`). Hex *strings* (names, serials)
 * are hex-digit-only, so they can never contain an "x" and never collide.
 */
export function isWireHex(value: unknown): value is string {
  return typeof value === "string" && HEX_TOKEN.test(value);
}

function quoteBrokenJson(text: string): string {
  return text.replace(KEY_QUOTE, '$1"$2"').replace(/'/g, '"').replace(HEX_QUOTE, '"$1"');
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (isWireHex(value)) {
      const parsed = Number.parseInt(value, 16);
      return Number.isNaN(parsed) ? value : parsed;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

/**
 * Parse a blob for *mutation*: hex tokens stay verbatim as `"0x03ff"` strings.
 * The firmware only accepts whole-blob writes, so every untouched field must
 * re-serialize byte-for-byte — including its zero padding, which the numeric
 * form would silently drop (`0x00000000` -> `0x00`).
 */
export function parseWireBlob(text: string): unknown {
  return JSON.parse(quoteBrokenJson(text)) as unknown;
}

/** Parse a blob for *decoding*: hex tokens become numbers. */
export function parseBlob(text: string): unknown {
  return normalize(parseWireBlob(text));
}

/** Largest value observed on the wire is 4 bytes; anything wider is a mistake. */
const MAX_WIRE_VALUE = 0xffffffff;

/**
 * Encode a number as a wire hex token, padded to an even number of digits.
 *
 * Values outside the representable range are rejected rather than encoded:
 * `Number.prototype.toString(16)` happily yields `-1` or `Infinity`, which
 * would be POSTed as the malformed tokens `0x-1` / `0xInfinity` and corrupt the
 * whole-blob write.
 */
export function toWireHex(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WIRE_VALUE) {
    throw new MikroMCPError({
      category: ErrorCategory.VALIDATION,
      code: "SWOS_VALUE_OUT_OF_RANGE",
      message: `Cannot encode ${value} as a SwOS wire value.`,
      details: { value, min: 0, max: MAX_WIRE_VALUE },
      recoverability: {
        retryable: false,
        suggestedAction: `Pass a whole number between 0 and ${MAX_WIRE_VALUE}.`,
      },
    });
  }
  const s = value.toString(16);
  return `0x${s.length % 2 ? `0${s}` : s}`;
}

/**
 * Encode `value` as a wire hex token, keeping the digit width of the value it
 * replaces so a mutated field stays the same size as the device sent it.
 */
export function encodeLike(value: number, existing: unknown): string {
  const token = toWireHex(value);
  if (!isWireHex(existing)) return token;
  const width = existing.length - 2;
  const digits = token.slice(2);
  return digits.length >= width ? token : `0x${digits.padStart(width, "0")}`;
}

function toHex(value: unknown): unknown {
  if (typeof value === "number") return toWireHex(value);
  if (Array.isArray(value)) return value.map(toHex);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toHex(v)]),
    );
  }
  return value;
}

export function dumpBlob(data: unknown): string {
  let s = JSON.stringify(toHex(data));
  s = s.replace(HEX_UNQUOTE, "0x$1");
  s = s.replace(KEY_UNQUOTE, "$1:");
  return s.replace(/"/g, "'");
}

// ---------------------------------------------------------------------------
// Shared enum tables (index order IS the wire value)
// ---------------------------------------------------------------------------

export const SPEED = ["10M", "100M", "1G", "10G", "200M", "2.5G", "5G", "down"] as const;
export const SPEED_SWOS = ["10M", "100M", "1G", "10G", "5G", "2.5G", "40G"] as const;
export const POE_OUT = ["off", "on", "auto"] as const;
export const POE_VOLTAGE = ["auto", "low", "high"] as const;
export const VLAN_MODE = ["disabled", "optional", "strict"] as const;
// Full SwOS adds "enabled" (VLAN filtering without ingress checking) before strict.
export const VLAN_MODE_SWOS = ["disabled", "optional", "enabled", "strict"] as const;
export const VLAN_RECV = ["any", "only_tagged", "only_untagged"] as const;
export const LAG_MODE = ["passive", "active", "static"] as const;

// Index 0 observed = "none" for non-PoE (SFP) ports, NOT short-circuit.
// (pkg-python3-mikrotik-swos guessed 0="short circuit"; corrected here.)
export const POE_STATE = [
  "none",
  "disabled",
  "waiting_for_load",
  "powered_on",
  "overload",
  "short_circuit",
  "voltage_too_low",
  "current_too_low",
  "power_cycle",
  "voltage_too_high",
  "controller_error",
] as const;

export const RSTP_ROLE = ["disabled", "alternate", "root", "designated", "backup"] as const;
export const FLOW_CONTROL = ["off", "tx_only", "rx_only", "on"] as const;
export const ACL_VLAN_PRESENT = ["any", "present", "not present"] as const;
export const ACL_ACCOUNT_AS = ["none", "#1", "#2", "#3", "#4"] as const;
export const ADDR_ACQ = ["DHCP with fallback", "static", "DHCP only"] as const;

// ---------------------------------------------------------------------------
// Endpoint schemas (keys: swos / swos_lite profile -> wire key)
// ---------------------------------------------------------------------------

const LINK: Endpoint = {
  path: "link.b",
  fields: [
    f("enabled", { swos: "en", swos_lite: "i01" }, Kind.BOOL),
    f("auto_neg", { swos: "an", swos_lite: "i02" }, Kind.BOOL),
    f("manual_duplex", { swos: "dpxc", swos_lite: "i03" }, Kind.BOOL),
    // Full SwOS: spdc is the configured speed (a select), spd the negotiated one.
    f("manual_speed", { swos: "spdc", swos_lite: "i05" }, Kind.OPTION, {
      options: SPEED,
      perPort: true,
      profiles: { swos: { options: SPEED_SWOS } },
    }),
    f("link", { swos: "lnk", swos_lite: "i06" }, Kind.BOOL),
    f("duplex", { swos: "dpx", swos_lite: "i07" }, Kind.BOOL),
    f("speed", { swos: "spd", swos_lite: "i08" }, Kind.OPTION, {
      options: SPEED,
      perPort: true,
      profiles: { swos: { options: SPEED_SWOS } },
    }),
    f("name", { swos: "nm", swos_lite: "i0a" }, Kind.STR, { perPort: true }),
    f("flow_rx", { swos: "fctr", swos_lite: "i12" }, Kind.BOOL),
    f("flow_tx", { swos: "fctc", swos_lite: "i16" }, Kind.BOOL),
    f("pause", { swos: "paus", swos_lite: "i15" }, Kind.BOOL),
    f("sfp_rate_select", { swos: "sfpr" }, Kind.OPTION, {
      options: ["low", "high"],
      perPort: true,
    }),
    f("combo_mode", { swos: "cm" }, Kind.OPTION, {
      options: ["auto", "copper", "sfp"],
      perPort: true,
    }),
    f("port_count", { swos: "prt" }, Kind.INT, { note: "number of ports (full SwOS)" }),
    f("sfp_count", { swos: "sfp" }, Kind.INT, { note: "number of SFP cages (full SwOS)" }),
    f("sfp_offset", { swos: "sfpo" }, Kind.INT, {
      note: "0-based index of the first SFP cage (full SwOS)",
    }),
    f("combo_ports", { swos: "comb" }, Kind.BOOL, { note: "mask of combo ports (full SwOS)" }),
    f("qsfp_ports", { swos: "qsfp" }, Kind.BOOL, { note: "mask of QSFP cages (full SwOS)" }),
    f("blocked", { swos: "blkp" }, Kind.BOOL, {
      unknown: true,
      note: "per-port mask, reads 0 on the CSS318; blocked ports? (full SwOS)",
    }),
    f("flow_tx_active", { swos: "tfct" }, Kind.BOOL, {
      note: "mask of ports with TX flow control negotiated (full SwOS)",
    }),
    f("flow_rx_active", { swos: "rfct" }, Kind.BOOL, {
      note: "mask of ports with RX flow control negotiated (full SwOS)",
    }),
    f("qsfp_type", { swos: "qtyp" }, Kind.INT, {
      perPort: true,
      unknown: true,
      note: "QSFP module type per port (full SwOS)",
    }),
    f("qsfp_offset", { swos: "qsfo" }, Kind.INT, {
      note: "0-based index of the first QSFP cage (full SwOS)",
    }),
    f("mgmt_port_offset", { swos: "mgmo" }, Kind.INT, {
      unknown: true,
      note: "management port offset (full SwOS)",
    }),
    f("mgmt_port_count", { swos: "mgmc" }, Kind.INT, {
      unknown: true,
      note: "management port count (full SwOS)",
    }),
    f("cable_pairs", { swos: "pair", swos_lite: "i11" }, Kind.INT, {
      perPort: true,
      note: "per-port cable-pair status; 0xffff = all pairs OK",
    }),
    f("flow_control", { swos_lite: "i13" }, Kind.OPTION, {
      options: FLOW_CONTROL,
      note: "negotiated flow-control mode",
    }),
    f("flow_control_mask", { swos_lite: "i14" }, Kind.BOOL, {
      note: "per-port mask paired with flow_control (i13)",
    }),
    f("cable_length", { swos_lite: "i09" }, Kind.INT, {
      perPort: true,
      unknown: true,
      note: "0 when link down; tracks cable run length -> likely length, scale ~1e-3 m (heuristic)",
    }),
    f("unknown_i0b", { swos_lite: "i0b" }, Kind.HEX, { unknown: true }),
    f("unknown_i0c", { swos_lite: "i0c" }, Kind.HEX, { unknown: true }),
    f("diag_hops", { swos: "hop", swos_lite: "i0d" }, Kind.HEX, { perPort: true, unknown: true }),
    f("diag_last_hop", { swos: "hops", swos_lite: "i0e" }, Kind.HEX, {
      perPort: true,
      unknown: true,
    }),
    f("diag_length", { swos: "len", swos_lite: "i0f" }, Kind.HEX, { perPort: true, unknown: true }),
    f("diag_fault_at", { swos: "flt", swos_lite: "i10" }, Kind.HEX, {
      perPort: true,
      unknown: true,
    }),
  ],
};

const SYS: Endpoint = {
  path: "sys.b",
  fields: [
    // Full SwOS counts centiseconds (a CSS318 on 2.19 advanced 2,039 in 20.4 s).
    f("uptime", { swos: "upt", swos_lite: "i01" }, Kind.INT, {
      note: "seconds",
      profiles: { swos: { scale: 100 } },
    }),
    f("ip", { swos: "cip", swos_lite: "i02" }, Kind.IP),
    f("mac", { swos: "mac", swos_lite: "i03" }, Kind.MAC),
    f("serial", { swos: "sid", swos_lite: "i04" }, Kind.STR),
    f("identity", { swos: "id", swos_lite: "i05" }, Kind.STR),
    f("version", { swos: "ver", swos_lite: "i06" }, Kind.STR),
    f("model", { swos: "brd", swos_lite: "i07" }, Kind.STR),
    f("discovery_protocol", { swos: "pdsc", swos_lite: "i08" }, Kind.BOOL, {
      note: "per-port bitmask of MikroTik discovery enabled",
    }),
    f("static_ip", { swos: "ip", swos_lite: "i09" }, Kind.IP),
    f("addr_acq", { swos: "iptp", swos_lite: "i0a" }, Kind.OPTION, { options: ADDR_ACQ }),
    f("build_number", { swos: "bld", swos_lite: "i0b" }, Kind.INT, {
      note: "full SwOS: build time as a Unix timestamp",
    }),
    f("allow_from_ports", { swos: "allp", swos_lite: "i12" }, Kind.BOOL),
    f("dhcp_trusted_ports", { swos: "dtrp", swos_lite: "i13" }, Kind.BOOL),
    f("dhcp_info_option", { swos: "ainf", swos_lite: "i14" }, Kind.CHECKBOX),
    f("psu1_voltage", { swos: "p1v", swos_lite: "i15" }, Kind.INT, { scale: 100, note: "volts" }),
    f("psu1_current", { swos: "p1c", swos_lite: "i16" }, Kind.INT, { note: "mA" }),
    f("igmp_snooping", { swos: "igmp", swos_lite: "i17" }, Kind.CHECKBOX),
    f("allow_from_ip", { swos: "alla", swos_lite: "i19" }, Kind.IP),
    f("allow_from_mask", { swos: "allm", swos_lite: "i1a" }, Kind.INT),
    f("allow_from_vlan", { swos: "avln", swos_lite: "i1b" }, Kind.INT),
    f("psu2_voltage", { swos: "p2v", swos_lite: "i1e" }, Kind.INT, { scale: 100 }),
    f("psu2_current", { swos: "p2c", swos_lite: "i1f" }, Kind.INT),
    f("bridge_priority", { swos: "prio", swos_lite: "i0e" }, Kind.INT),
    f("port_cost_mode", { swos: "cost", swos_lite: "i0f" }, Kind.OPTION, {
      options: ["short", "long"],
    }),
    f("root_bridge_priority", { swos: "rpr", swos_lite: "i10" }, Kind.INT),
    f("igmp_fast_leave", { swos: "igfl", swos_lite: "i27" }, Kind.BOOL),
    f("igmp_version", { swos: "igve", swos_lite: "i28" }, Kind.OPTION, { options: ["v2", "v3"] }),
    f("igmp_querier", { swos: "igmq", swos_lite: "i29" }, Kind.CHECKBOX),
    f("fwd_reserved_mc", { swos: "frmc", swos_lite: "i2a" }, Kind.CHECKBOX),
    f("independent_vlan_lookup", { swos: "ivl" }, Kind.CHECKBOX, {
      note: "IVL; per-VLAN IGMP snooping needs it",
    }),
    f("eth_boot_port", { swos: "mgmt" }, Kind.CHECKBOX, { note: "ETH/BOOT port enabled (CRS)" }),
    f("board_name", { swos: "mrkt" }, Kind.STR),
    f("revision", { swos: "rev" }, Kind.STR),
    f("root_bridge_mac", { swos: "rmac", swos_lite: "i11" }, Kind.MAC),
    f("cpu_temp", { swos: "temp", swos_lite: "i22" }, Kind.INT, {
      signed: true,
      bits: 16,
      note: "deg C",
      profiles: { swos: { bits: 32 } },
    }),
    f("board_temp_1", { swos: "btm1" }, Kind.INT, { signed: true, bits: 32, note: "deg C" }),
    f("board_temp_2", { swos: "btm2" }, Kind.INT, { signed: true, bits: 32, note: "deg C" }),
    f("phy_temp", { swos: "phyt" }, Kind.INT, { signed: true, bits: 32, note: "deg C" }),
    f("fan_1", { swos: "fan1" }, Kind.INT, { note: "RPM" }),
    f("fan_2", { swos: "fan2" }, Kind.INT, { note: "RPM" }),
    f("fan_3", { swos: "fan3" }, Kind.INT, { note: "RPM" }),
    f("fan_4", { swos: "fan4" }, Kind.INT, { note: "RPM" }),
    // The rest of sys.b as a CSS318 on 2.19 sends it (sanitized capture in
    // test/fixtures/swos-full-real/). Meanings come from the web UI's labels
    // where there is one; the others are kept by name so a write re-sends them.
    f("watchdog", { swos: "wdt" }, Kind.CHECKBOX, { note: "System watchdog (full SwOS)" }),
    f("discovery_enabled", { swos: "dsc" }, Kind.CHECKBOX, {
      note: "MikroTik discovery on/off; pdsc is the per-port mask (full SwOS)",
    }),
    f("psu1_status", { swos: "p1s" }, Kind.INT, { unknown: true, note: "PSU 1 state (full SwOS)" }),
    f("psu2_status", { swos: "p2s" }, Kind.INT, { unknown: true, note: "PSU 2 state (full SwOS)" }),
    f("psu1_fan", { swos: "p1f" }, Kind.INT, { unknown: true, note: "PSU 1 fan? (full SwOS)" }),
    f("psu2_fan", { swos: "p2f" }, Kind.INT, { unknown: true, note: "PSU 2 fan? (full SwOS)" }),
    f("psu1_power", { swos: "p1p" }, Kind.INT, { unknown: true, note: "PSU 1 power? (full SwOS)" }),
    f("psu2_power", { swos: "p2p" }, Kind.INT, { unknown: true, note: "PSU 2 power? (full SwOS)" }),
    f("psu1_temp", { swos: "p1t" }, Kind.INT, {
      unknown: true,
      note: "PSU 1 temperature? (full SwOS)",
    }),
    f("psu2_temp", { swos: "p2t" }, Kind.INT, {
      unknown: true,
      note: "PSU 2 temperature? (full SwOS)",
    }),
    f("poe_present", { swos: "poe" }, Kind.INT, {
      unknown: true,
      note: "PoE capability flag (full SwOS)",
    }),
    f("poe_state", { swos: "poes" }, Kind.INT, { unknown: true, note: "PoE state (full SwOS)" }),
    f("poe_ports", { swos: "npoe" }, Kind.INT, {
      unknown: true,
      note: "number of PoE ports? (full SwOS)",
    }),
    f("upgrade_state", { swos: "upgr" }, Kind.INT, {
      unknown: true,
      note: "firmware upgrade state (full SwOS)",
    }),
    f("alt_mac", { swos: "amac" }, Kind.MAC, {
      unknown: true,
      note: "second MAC the web UI shows next to the system MAC (full SwOS)",
    }),
    f("power_consumption", { swos_lite: "i26" }, Kind.INT, {
      scale: 10,
      note: "watts (switch itself, excl. PoE)",
    }),
  ],
};

const POE: Endpoint = {
  path: "poe.b",
  fields: [
    f("out", { swos_lite: "i01" }, Kind.OPTION, { options: POE_OUT, perPort: true }),
    f("priority", { swos_lite: "i02" }, Kind.INT, {
      perPort: true,
      note: "wire = priority-1 (0..7 -> 1..8)",
    }),
    f("voltage_level", { swos_lite: "i03" }, Kind.OPTION, {
      options: POE_VOLTAGE,
      perPort: true,
    }),
    f("state", { swos_lite: "i04" }, Kind.OPTION, { options: POE_STATE, perPort: true }),
    f("current", { swos_lite: "i05" }, Kind.INT, { perPort: true, note: "mA" }),
    f("voltage", { swos_lite: "i06" }, Kind.INT, { perPort: true, scale: 10, note: "volts" }),
    f("power", { swos_lite: "i07" }, Kind.INT, { perPort: true, scale: 10, note: "watts" }),
    f("total_raw", { swos_lite: "i08" }, Kind.INT, {
      unknown: true,
      note: "global PoE total (raw); semantics TBD",
    }),
    f("controller", { swos_lite: "i09" }, Kind.STR, {
      unknown: true,
      note: "PoE controller serial/fw string",
    }),
    f("lldp_enabled", { swos_lite: "i0a" }, Kind.CHECKBOX, {
      unknown: true,
      note: "global LLDP toggle (Lite); per-port in some firmwares",
    }),
    f("lldp_power", { swos_lite: "i0b" }, Kind.INT, {
      perPort: true,
      scale: 10,
      unknown: true,
      note: "per-port LLDP negotiated power",
    }),
  ],
};

const LACP: Endpoint = {
  path: "lacp.b",
  fields: [
    f("active", { swos_lite: "i01" }, Kind.INT, {
      perPort: true,
      note: "per-port LACP active/member flag (0/1)",
    }),
    f("mode", { swos: "mode" }, Kind.OPTION, { options: LAG_MODE, perPort: true }),
    f("trunk_id", { swos: "grp", swos_lite: "i02" }, Kind.INT, {
      perPort: true,
      note: "static LAG / trunk id (observed 1, 2 and 3)",
    }),
    f("group", { swos: "sgrp", swos_lite: "i03" }, Kind.INT, {
      perPort: true,
      note: "LAG group, engine max 15",
    }),
    f("partner_mac", { swos: "mac", swos_lite: "i04" }, Kind.MAC, {
      perPort: true,
      note: "LACP partner/peer MAC (same value for both members of a LAG)",
    }),
  ],
};

const RSTP: Endpoint = {
  path: "rstp.b",
  fields: [
    f("enabled", { swos: "ena", swos_lite: "i01" }, Kind.BOOL, {
      note: "per-port RSTP-enabled mask (0x3ff = all)",
    }),
    f("role", { swos: "role", swos_lite: "i02" }, Kind.OPTION, {
      options: RSTP_ROLE,
      perPort: true,
      note: "per-port RSTP role",
    }),
    f("rstp_mode", { swos: "rstp" }, Kind.BOOL, {
      note: "per-port mask: set = RSTP, clear = STP (full SwOS)",
    }),
    f("point_to_point", { swos: "p2p" }, Kind.BOOL, { note: "per-port mask (full SwOS)" }),
    f("edge", { swos: "edge" }, Kind.BOOL, { note: "per-port mask (full SwOS)" }),
    f("root_path_cost", { swos: "rpc", swos_lite: "i03" }, Kind.INT, {
      perPort: true,
      note: "per-port root path cost (0 = auto)",
    }),
    f("unknown_i04", { swos_lite: "i04" }, Kind.INT, {
      perPort: true,
      unknown: true,
      note: "observed 0/2/4/0x13; candidate = port priority / port number",
    }),
    f("mode_mask", { swos_lite: "i05" }, Kind.BOOL, {
      unknown: true,
      note: "0x3ff on this device; candidate = STP/RSTP mode mask",
    }),
    f("type_mask", { swos_lite: "i06" }, Kind.BOOL, {
      unknown: true,
      note: "0x3ff here; candidate = port type mask (paired with i07)",
    }),
    f("unknown_i07", { swos_lite: "i07" }, Kind.INT, {
      unknown: true,
      note: "0x324 here; paired mask for i06",
    }),
    f("forwarding", { swos: "fwd", swos_lite: "i08" }, Kind.BOOL, {
      note: "forwarding-state mask (port4 down -> bit clear)",
    }),
    f("learning", { swos: "lrn", swos_lite: "i09" }, Kind.BOOL, {
      note: "learning-state mask (port4 down -> bit clear)",
    }),
  ],
};

const SNMP: Endpoint = {
  path: "snmp.b",
  fields: [
    f("enabled", { swos: "en", swos_lite: "i01" }, Kind.CHECKBOX),
    f("community", { swos: "com", swos_lite: "i02" }, Kind.STR),
    f("contact", { swos: "ci", swos_lite: "i03" }, Kind.STR),
    f("location", { swos: "loc", swos_lite: "i04" }, Kind.STR),
  ],
};

/** Upper bound for per-port key families (fp1..fpN); the largest SwOS switch has 54 ports. */
export const MAX_SWOS_PORTS = 64;

const FWD: Endpoint = {
  path: "fwd.b",
  fields: [
    // One "forward to" mask per source port. Lite numbers them i01..i0a (its
    // ten ports); full SwOS names them fp1..fpN for however many ports it has.
    ...Array.from({ length: MAX_SWOS_PORTS }, (_, i) =>
      f(
        `isolation_p${i + 1}`,
        i < 10
          ? { swos: `fp${i + 1}`, swos_lite: `i${(i + 1).toString(16).padStart(2, "0")}` }
          : { swos: `fp${i + 1}` },
        Kind.BOOL,
        {
          note: "forwarding/isolation mask; bit n cleared",
        },
      ),
    ),
    f("port_lock", { swos: "lck", swos_lite: "i10" }, Kind.BOOL, {
      perPort: true,
      note: "port lock (disable learning)",
    }),
    f("lock_on_first", { swos: "lckf", swos_lite: "i11" }, Kind.BOOL, {
      perPort: true,
      note: "lock on first learned MAC",
    }),
    f("mirror_ingress", { swos: "imr", swos_lite: "i12" }, Kind.BOOL, { perPort: true }),
    f("mirror_egress", { swos: "omr", swos_lite: "i13" }, Kind.BOOL, { perPort: true }),
    f("mirror_to", { swos: "mrto", swos_lite: "i14" }, Kind.BOOL, {
      perPort: true,
      note: "egress mirror target port (scalar mask on this device)",
    }),
    f("vlan_mode", { swos: "vlan", swos_lite: "i15" }, Kind.OPTION, {
      options: VLAN_MODE,
      perPort: true,
      profiles: { swos: { options: VLAN_MODE_SWOS } },
    }),
    f("vlan_recv_mode", { swos: "vlni", swos_lite: "i17" }, Kind.OPTION, {
      options: VLAN_RECV,
      perPort: true,
    }),
    f("default_vid", { swos: "dvid", swos_lite: "i18" }, Kind.INT, {
      perPort: true,
      note: "default VLAN id per port",
    }),
    f("force_vid", { swos: "fvid", swos_lite: "i19" }, Kind.BOOL, {
      perPort: true,
      note: "force VLAN id",
    }),
    f("storm_rate", { swos: "srt", swos_lite: "i1a" }, Kind.INT, {
      perPort: true,
      scale: 1e5,
      note: "storm limit (fraction of link)",
      profiles: { swos: { scale: undefined, note: "storm limit in % of link speed (1..100)" } },
    }),
    f("limit_unknown_ucast", { swos: "suni", swos_lite: "i1b" }, Kind.BOOL, {
      perPort: true,
      note: "limit unknown unicast",
    }),
    f("flood_unknown_mcast", { swos: "fmc", swos_lite: "i1c" }, Kind.BOOL, {
      perPort: true,
      note: "flood unknown multicast",
    }),
    f("ingress_rate", { swos: "ir", swos_lite: "i1d" }, Kind.INT, {
      perPort: true,
      scale: 1e5,
      note: "ingress rate limit (fraction of link)",
      profiles: {
        swos: {
          scale: undefined,
          unknown: true,
          note: "ingress limit, raw (the web UI shows it multiplied by 0.001); unverified",
        },
      },
    }),
    f("egress_rate", { swos_lite: "i1e" }, Kind.INT, {
      perPort: true,
      scale: 1e5,
      note: "egress rate limit (fraction of link)",
    }),
  ],
};

// vlan.b / host.b / !dhost.b / !igmp.b / acl.b: records. SwOS Lite iNN keys for
// vlan.b are unverified (device had no VLANs); only legacy swos mnemonics map.
const VLAN: Endpoint = {
  path: "vlan.b",
  isArray: true,
  note: "SwOS Lite vlan.b keys unverified (device had none)",
  fields: [
    f("vid", { swos: "vid" }, Kind.INT),
    f("name", { swos: "nm" }, Kind.STR),
    f("port_isolation", { swos: "piso" }, Kind.CHECKBOX),
    f("learning", { swos: "lrn" }, Kind.CHECKBOX),
    f("mirror", { swos: "mrr" }, Kind.CHECKBOX),
    f("igmp", { swos: "igmp" }, Kind.CHECKBOX),
    f("members", { swos: "mbr" }, Kind.BOOL),
  ],
};

const HOST: Endpoint = {
  path: "host.b",
  isArray: true,
  note: "Static host table (device had none)",
  fields: [
    f("mac", { swos: "adr", swos_lite: "i01" }, Kind.MAC),
    f("port", { swos: "prt", swos_lite: "i02" }, Kind.INT, {
      note: "port id; 0x80 bit = SFP/combo, low nibble = 1-based port (interpretation unverified)",
      profiles: { swos: { note: "port index (full SwOS); 0x80 + n = trunk n", unknown: true } },
    }),
    f("vid", { swos: "vid" }, Kind.INT, { note: "VLAN id (full SwOS)" }),
    f("drop", { swos: "drp" }, Kind.CHECKBOX),
    f("mirror", { swos: "mir" }, Kind.CHECKBOX),
  ],
};

const DHOST: Endpoint = {
  path: "!dhost.b",
  isArray: true,
  note: "Dynamically learned MAC table",
  fields: HOST.fields,
};

const IGMP: Endpoint = {
  path: "!igmp.b",
  isArray: true,
  note: "IGMP snooping groups (device had none)",
  fields: [
    f("group_address", { swos: "addr", swos_lite: "i01" }, Kind.INT, {
      note: "multicast group IP (raw int)",
      profiles: { swos: { kind: Kind.IP, note: "multicast group IP" } },
    }),
    f("member_ports", { swos: "prts", swos_lite: "i02" }, Kind.BOOL, {
      note: "per-port membership bitmask",
    }),
    f("vlan", { swos: "vlan", swos_lite: "i03" }, Kind.INT, { note: "VLAN id" }),
  ],
};

const ACL: Endpoint = {
  path: "acl.b",
  isArray: true,
  note: "ACL rules (device had none)",
  fields: [
    f("from", { swos: "frm", swos_lite: "i01" }, Kind.BOOL, { note: "source port bitmask" }),
    f("mac_src", { swos: "smac", swos_lite: "i02" }, Kind.MAC),
    f("mac_src_mask", { swos: "smsk", swos_lite: "i03" }, Kind.MAC),
    f("mac_dst", { swos: "dmac", swos_lite: "i04" }, Kind.MAC),
    f("mac_dst_mask", { swos: "dmsk", swos_lite: "i05" }, Kind.MAC),
    f("ethertype", { swos: "et", swos_lite: "i06" }, Kind.INT),
    f("vlan_present", { swos: "vtag", swos_lite: "i07" }, Kind.OPTION, {
      options: ACL_VLAN_PRESENT,
    }),
    f("vlan_id", { swos: "vlan", swos_lite: "i08" }, Kind.INT),
    f("priority", { swos: "prio", swos_lite: "i09" }, Kind.INT),
    f("ip_src", { swos: "sip", swos_lite: "i0a" }, Kind.INT, {
      note: "source IP (raw int)",
      profiles: { swos: { kind: Kind.IP, note: "source IP" } },
    }),
    f("ip_src_mask_hi", { swos_lite: "i0b" }, Kind.INT),
    f("ip_src_mask_lo", { swos_lite: "i0c" }, Kind.INT),
    f("ip_src_prefix", { swos: "sipm" }, Kind.INT, { note: "source prefix length (full SwOS)" }),
    f("port_src", { swos: "sprt" }, Kind.INT, { note: "source L4 port (full SwOS)" }),
    f("ip_dst", { swos: "dip", swos_lite: "i0d" }, Kind.INT, {
      note: "dest IP (raw int)",
      profiles: { swos: { kind: Kind.IP, note: "dest IP" } },
    }),
    f("ip_dst_mask_hi", { swos_lite: "i0e" }, Kind.INT),
    f("ip_dst_mask_lo", { swos_lite: "i0f" }, Kind.INT),
    f("ip_dst_prefix", { swos: "dipm" }, Kind.INT, { note: "dest prefix length (full SwOS)" }),
    f("port_dst", { swos: "dprt" }, Kind.INT, { note: "dest L4 port (full SwOS)" }),
    f("protocol", { swos: "prot", swos_lite: "i10" }, Kind.INT),
    f("dscp", { swos: "dscp", swos_lite: "i11" }, Kind.INT),
    f("drop", { swos_lite: "i12" }, Kind.CHECKBOX, { note: "drop matching packets" }),
    f("mirror_to", { swos_lite: "i13" }, Kind.OPTION, { note: "egress port / off" }),
    f("redirect_to", { swos: "rdto", swos_lite: "i14" }, Kind.OPTION, {
      note: "egress port / off",
    }),
    f("rate", { swos: "rate" }, Kind.INT, { note: "rate limit (full SwOS)" }),
    f("hits", { swos: "pkts" }, Kind.INT, { note: "matched packets (full SwOS, read-only)" }),
    f("set_vlan_id", { swos: "svid", swos_lite: "i15" }, Kind.INT),
    f("set_priority", { swos: "spri", swos_lite: "i16" }, Kind.INT),
    f("set_dscp", { swos_lite: "i17" }, Kind.INT),
    f("account_as", { swos_lite: "i18" }, Kind.OPTION, { options: ACL_ACCOUNT_AS }),
  ],
};

const ACLSTATS: Endpoint = {
  path: "!aclstats.b",
  fields: [
    f("counter_1", { swos_lite: "i01" }, Kind.INT, { perPort: true }),
    f("counter_2", { swos_lite: "i02" }, Kind.INT, { perPort: true }),
    f("counter_3", { swos_lite: "i03" }, Kind.INT, { perPort: true }),
    f("counter_4", { swos_lite: "i04" }, Kind.INT, { perPort: true }),
  ],
};

const SFP: Endpoint = {
  path: "sfp.b",
  note: "per-cage SFP DOM diagnostics (text fields are UTF-8 over hex)",
  fields: [
    f("vendor", { swos: "vnd", swos_lite: "i01" }, Kind.STR, { perPort: true }),
    f("part_number", { swos: "pnr", swos_lite: "i02" }, Kind.STR, { perPort: true }),
    f("revision", { swos: "rev", swos_lite: "i03" }, Kind.STR, { perPort: true }),
    f("serial", { swos: "ser", swos_lite: "i04" }, Kind.STR, { perPort: true }),
    f("date", { swos: "dat", swos_lite: "i05" }, Kind.STR, { perPort: true }),
    f("type", { swos_lite: "i06" }, Kind.STR, { perPort: true, note: "xa:1 = hex-ascii" }),
    f("diag_extra", { swos_lite: "i07" }, Kind.INT, {
      perPort: true,
      unknown: true,
      note: "firmware-specific raw value (85000 on the populated cage); purpose unconfirmed",
    }),
    // Signed like sys.b cpu_temp. A cage with no DOM (passive copper DAC)
    // reports 0xff80 -> -128, which reads as "no reading" rather than 65408.
    f("temperature", { swos: "tmp", swos_lite: "i08" }, Kind.INT, {
      perPort: true,
      signed: true,
      bits: 16,
      note: "deg C; -128 = no DOM data (e.g. passive DAC)",
    }),
    f("voltage", { swos: "vcc", swos_lite: "i09" }, Kind.INT, {
      perPort: true,
      scale: 1000,
      note: "volts",
    }),
    f("tx_bias", { swos: "tbs", swos_lite: "i0a" }, Kind.INT, { perPort: true, note: "mA" }),
    f("tx_power", { swos: "tpw", swos_lite: "i0b" }, Kind.INT, {
      perPort: true,
      scale: 10000,
      note: "dBm",
    }),
    f("rx_power", { swos: "rpw", swos_lite: "i0c" }, Kind.INT, {
      perPort: true,
      scale: 10000,
      note: "dBm",
    }),
  ],
};

// stats.b: per-port cumulative counters. Every key is a per-port int array of
// length = port count. Raw iNN keys preserved; friendly aliases from
// STATS_METRICS (sourced from engine.js Stats / Errors / Hist tabs).
const STATS: Endpoint = {
  path: "!stats.b",
  fields: [],
  genericPerPort: true,
  note: "Per-port cumulative counters (rx/tx bytes, packets, errors, drops...). iNN keys preserved as-is.",
};

export const STATS_METRICS: Record<string, string> = {
  i01: "rx_bytes",
  i0f: "tx_bytes",
  i05: "rx_unicasts",
  i11: "tx_unicasts",
  i07: "rx_broadcasts",
  i14: "tx_broadcasts",
  i08: "rx_multicasts",
  i13: "tx_multicasts",
  i23: "rx_total_packets",
  i24: "tx_total_packets",
  i21: "rx_rate",
  i22: "tx_rate",
  i25: "rx_packet_rate",
  i26: "tx_packet_rate",
  i17: "rx_pauses",
  i1d: "rx_errors",
  i1e: "rx_fcs_errors",
  i1c: "rx_jabber",
  i19: "rx_runt",
  i1a: "rx_fragments",
  i1b: "rx_too_long",
  i16: "tx_pauses",
  i04: "tx_fcs_errors",
  i1f: "tx_collisions",
  i15: "tx_single_collisions",
  i18: "tx_multiple_collisions",
  i12: "tx_excessive_collisions",
  i20: "tx_late_collisions",
  i06: "tx_deferred",
  i09: "pkt_64",
  i0a: "pkt_65_127",
  i0b: "pkt_128_255",
  i0c: "pkt_256_511",
  i0d: "pkt_512_1023",
  i0e: "pkt_1024_max",
  // Full SwOS mnemonics (Stats / Errors / Hist tabs of the SwOS web UI)
  rb: "rx_bytes",
  tb: "tx_bytes",
  rup: "rx_unicasts",
  tup: "tx_unicasts",
  rbp: "rx_broadcasts",
  tbp: "tx_broadcasts",
  rmp: "rx_multicasts",
  tmp: "tx_multicasts",
  rtp: "rx_total_packets",
  ttp: "tx_total_packets",
  rrb: "rx_rate",
  trb: "tx_rate",
  rrp: "rx_packet_rate",
  trp: "tx_packet_rate",
  rpp: "rx_pauses",
  rte: "rx_errors",
  rfcs: "rx_fcs_errors",
  rae: "rx_jabber",
  rr: "rx_runt",
  fr: "rx_fragments",
  rov: "rx_overruns",
  tpp: "tx_pauses",
  tur: "tx_underruns",
  tcl: "tx_collisions",
  tmc: "tx_multiple_collisions",
  tec: "tx_excessive_collisions",
  tlc: "tx_late_collisions",
  tdf: "tx_deferred",
  p64: "pkt_64",
  p65: "pkt_65_127",
  p128: "pkt_128_255",
  p256: "pkt_256_511",
  p512: "pkt_512_1023",
  p1k: "pkt_1024_max",
};

export const SWOS_SCHEMA: Record<string, Endpoint> = {
  "link.b": LINK,
  "sys.b": SYS,
  "poe.b": POE,
  "lacp.b": LACP,
  "rstp.b": RSTP,
  "snmp.b": SNMP,
  "fwd.b": FWD,
  "vlan.b": VLAN,
  // SwOS Lite only serves the "!" form (a plain /stats.b 303s to /index.html);
  // the full SwOS web UI reads the plain path.
  "!stats.b": STATS,
  "stats.b": { ...STATS, path: "stats.b" },
  "sfp.b": SFP,
  "host.b": HOST,
  "!dhost.b": DHOST,
  "!igmp.b": IGMP,
  "acl.b": ACL,
  "!aclstats.b": ACLSTATS,
};

export const SWOS_ENDPOINTS: string[] = Object.keys(SWOS_SCHEMA).sort();

/** The web UI refuses longer passwords; the 32-byte change buffer holds two of them. */
export const MAX_SWOS_PASSWORD_LENGTH = 15;

/**
 * The `/!pwd.b` payload that changes the admin password, as the SwOS web UI
 * builds it: old password, NUL, new password, zero-padded to 32 bytes, XORed
 * with 64 bytes of an RC4 keystream (wrapping at 32) keyed by the old password
 * (`*` when empty) repeated to 16 characters. Hex-encoded.
 */
export function encodePasswordChange(oldPassword: string, newPassword: string): string {
  const buf = new Uint8Array(32);
  const bytes = [...Buffer.from(oldPassword, "latin1"), 0, ...Buffer.from(newPassword, "latin1")];
  bytes.slice(0, 32).forEach((b, i) => (buf[i] = b));

  let keyText = oldPassword === "" ? "*" : oldPassword;
  while (keyText.length < 16) keyText += keyText;
  const key = Buffer.from(keyText.slice(0, 16), "latin1");

  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + key[i % key.length] + S[i]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  for (let n = 0, i = 0, j = 0; n < 64; n++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
    buf[n & 31] ^= S[(S[i] + S[j]) & 255];
  }
  return Buffer.from(buf).toString("hex");
}

/** Endpoints whose blob carries a credential (the SNMP community). */
export const SECRET_ENDPOINTS: ReadonlySet<string> = new Set(["snmp.b"]);

/** A blob as it may appear in tool output or error details. */
export function presentableBlob(endpoint: string, blob: string): string {
  return SECRET_ENDPOINTS.has(endpoint) ? "<withheld: holds the SNMP community>" : blob;
}

// ---------------------------------------------------------------------------
// Firmware compatibility
// ---------------------------------------------------------------------------

/**
 * Model/firmware combinations this schema was actually validated against.
 *
 * MikroTik documents none of this, so the field meanings above are only as
 * true as the firmware they were read from. Extend this list when a capture
 * from another device has been diffed against the schema — not merely when a
 * device happens to respond.
 */
export const VERIFIED_FIRMWARE: readonly { model: string; version: string }[] = [
  { model: "CSS610-8P-2S+", version: "2.21" },
  // Full SwOS: sys.b, link.b, fwd.b, vlan.b, lacp.b and snmp.b captured from the
  // device (test/fixtures/swos-full-real/), round-tripped byte-for-byte, and
  // get_swos_config / apply_swos_config run against it end to end.
  { model: "CSS318-16G-2S+", version: "2.19" },
];

export interface FirmwareSupport {
  model?: string;
  version?: string;
  /** True only for an exact model + version match in VERIFIED_FIRMWARE. */
  verified: boolean;
  note: string;
}

const verifiedList = (): string =>
  VERIFIED_FIRMWARE.map((v) => `${v.model} ${v.version}`).join(", ");

/**
 * Classify a device against the verified set.
 *
 * A version check cannot prove a schema still fits — only a mismatch is
 * evidence, and only of risk. It exists so an unverified firmware is stated
 * out loud at the moment of a write rather than assumed to be fine.
 */
export function firmwareSupport(model: unknown, version: unknown): FirmwareSupport {
  const m = typeof model === "string" ? model : undefined;
  const v = typeof version === "string" ? version : undefined;

  if (m === undefined || v === undefined) {
    return {
      model: m,
      version: v,
      verified: false,
      note: `Firmware could not be identified; the schema is verified against ${verifiedList()}.`,
    };
  }
  if (VERIFIED_FIRMWARE.some((entry) => entry.model === m && entry.version === v)) {
    return {
      model: m,
      version: v,
      verified: true,
      note: `${m} ${v} — schema verified on this firmware.`,
    };
  }

  const sameModel = VERIFIED_FIRMWARE.filter((entry) => entry.model === m).map((e) => e.version);
  return {
    model: m,
    version: v,
    verified: false,
    note:
      sameModel.length > 0
        ? `${m} runs ${v}; the schema was verified on ${sameModel.join(", ")}. Field meanings may have changed — review the diff before applying.`
        : `${m} ${v} is not in the verified set (${verifiedList()}). Field meanings are inferred — review the diff before applying.`,
  };
}

/**
 * Wire keys the device sent that this endpoint's schema does not map — i.e.
 * fields a newer firmware added. They are preserved verbatim across a write,
 * but they are worth naming: they are the visible edge of schema drift.
 */
export function unmappedWireKeys(endpoint: string, wire: Record<string, unknown>): string[] {
  const ep = SWOS_SCHEMA[endpoint];
  if (!ep || ep.isArray || ep.genericPerPort) return [];
  const mapped = new Set(ep.fields.map((field) => selectKey(field, wire)));
  return Object.keys(wire).filter((key) => !mapped.has(key));
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

function inferPortCount(data: Record<string, unknown>): number {
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length > 0 && !Array.isArray(v[0]) && typeof v[0] !== "object") {
      return v.length;
    }
  }
  return 0;
}

/**
 * Port count for blobs that carry no per-port arrays at all (sys.b is entirely
 * scalar). Every BOOL field there is a per-port bitmask, so the widest mask
 * gives the port count — without this the bit lists decode to `[]`.
 */
function inferPortCountFromMasks(ep: Endpoint, data: Record<string, unknown>): number {
  let widest = 0;
  for (const fieldDef of ep.fields) {
    if (fieldDef.kind !== Kind.BOOL) continue;
    const key = selectKey(fieldDef, data);
    const value = key === undefined ? undefined : data[key];
    if (typeof value === "number" && value > 0) {
      widest = Math.max(widest, value.toString(2).length);
    }
  }
  return widest;
}

/**
 * The wire key this field uses in *this* blob. A field carries one key per
 * firmware dialect and the two namespaces are disjoint, so whichever key the
 * device actually sent identifies the dialect — no configuration needed.
 */
export function selectKey(fieldDef: Field, data: Record<string, unknown>): string | undefined {
  return Object.values(fieldDef.keys).find((key) => key in data);
}

/** The dialect a wire key belongs to for this field. */
export function profileOf(fieldDef: Field, key: string): SwosProfile | undefined {
  const entry = Object.entries(fieldDef.keys).find(([, k]) => k === key);
  return entry ? (entry[0] as SwosProfile) : undefined;
}

/**
 * The field as the dialect behind `key` encodes it: the base definition with
 * that dialect's overrides (option list, scale, width) applied. Decoding and
 * encoding must both go through this, or a full-SwOS VLAN mode of 3 ("strict")
 * would be read against the three-entry Lite list.
 */
export function fieldFor(fieldDef: Field, key: string | undefined): Field {
  const profile = key === undefined ? undefined : profileOf(fieldDef, key);
  const override = profile ? fieldDef.profiles?.[profile] : undefined;
  return override ? { ...fieldDef, ...override } : fieldDef;
}

function hexToBoolList(value: number, length: number): boolean[] {
  const bits = value
    .toString(2)
    .padStart(length, "0")
    .split("")
    .reverse()
    .map((b) => b === "1");
  return bits.slice(0, length);
}

function decodeScalar(fieldDef: Field, value: unknown, portCount: number): unknown {
  switch (fieldDef.kind) {
    case Kind.BOOL:
      return hexToBoolList(value as number, portCount);
    case Kind.STR: {
      const hex = value as string;
      const buf = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
      // SFP fields are fixed-width and space-padded; other strings are NUL-padded.
      return buf.toString("utf8").replace(/[\0\s]+$/g, "");
    }
    case Kind.OPTION: {
      const idx = value as number;
      return fieldDef.options && idx < fieldDef.options.length ? fieldDef.options[idx] : idx;
    }
    case Kind.MAC:
      return (value as string).toUpperCase().match(/../g)?.join(":") ?? "";
    case Kind.IP:
      if (!value) return "0.0.0.0";
      return Buffer.from((value as number).toString(16).padStart(8, "0"), "hex")
        .reverse()
        .join(".");
    case Kind.CHECKBOX:
      return value === 1;
    case Kind.INT: {
      let num = value as number;
      if (fieldDef.signed && fieldDef.bits) {
        // Not `1 << bits`: JS shifts are 32-bit, so 1 << 32 is 1 and 1 << 31 is negative.
        const half = 2 ** (fieldDef.bits - 1);
        if (num >= half) num -= 2 ** fieldDef.bits;
      }
      return fieldDef.scale ? num / fieldDef.scale : num;
    }
    default:
      return value;
  }
}

function decodeObject(
  ep: Endpoint,
  data: Record<string, unknown>,
  knownPortCount?: number,
): DecodedBlob {
  const portCount = knownPortCount || inferPortCount(data) || inferPortCountFromMasks(ep, data);
  const out: DecodedBlob = {};
  const knownKeys = new Set<string>();

  for (const baseDef of ep.fields) {
    const key = selectKey(baseDef, data);
    if (key === undefined) continue;
    const fieldDef = fieldFor(baseDef, key);
    knownKeys.add(key);
    const v = data[key];
    if (fieldDef.perPort || fieldDef.kind === Kind.BOOL) {
      out[fieldDef.name] = Array.isArray(v)
        ? v.map((x) => decodeScalar(fieldDef, x, portCount))
        : decodeScalar(fieldDef, v, portCount);
    } else {
      out[fieldDef.name] = decodeScalar(fieldDef, v, portCount);
    }
  }

  out["_raw"] = Object.fromEntries(Object.entries(data).filter(([k]) => !knownKeys.has(k)));
  return out;
}

function decodeRecords(ep: Endpoint, data: unknown[], knownPortCount?: number): unknown[] {
  return data.map((item) => {
    const row: Record<string, unknown> = {};
    const itemObj = item as Record<string, unknown>;
    const knownKeys = new Set<string>();
    for (const baseDef of ep.fields) {
      const key = selectKey(baseDef, itemObj);
      if (key === undefined) continue;
      const fieldDef = fieldFor(baseDef, key);
      knownKeys.add(key);
      // A record's port bitmask (VLAN members, ACL "from") is only as wide as
      // its highest set bit unless the caller knows the switch's port count.
      const width =
        knownPortCount ??
        (typeof itemObj[key] === "number" ? (itemObj[key] as number).toString(2).length : 0);
      row[fieldDef.name] = decodeScalar(fieldDef, itemObj[key], width);
    }
    row["_raw"] = Object.fromEntries(Object.entries(itemObj).filter(([k]) => !knownKeys.has(k)));
    return row;
  });
}

function decodeGenericPerPort(data: Record<string, unknown>): Record<string, unknown> {
  const portCount = inferPortCount(data);
  const ports: Record<string, unknown> = {};
  for (let n = 1; n <= portCount; n++) ports[String(n)] = {};
  const scalars: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(data)) {
    if (
      Array.isArray(v) &&
      v.length === portCount &&
      !Array.isArray(v[0]) &&
      typeof v[0] !== "object"
    ) {
      for (let n = 0; n < portCount; n++) {
        const port = ports[String(n + 1)] as Record<string, unknown>;
        port[k] = v[n];
        if (STATS_METRICS[k]) port[STATS_METRICS[k]] = v[n];
      }
    } else {
      scalars[k] = v;
    }
  }
  ports["_scalars"] = scalars;
  return ports;
}

/**
 * Decode a blob into the schema. `portCount` sizes per-port bitmasks exactly;
 * without it the width is inferred from the blob, which under-counts a mask
 * whose highest ports are clear (sys.b and vlan.b carry no per-port arrays).
 */
export function decodeEndpoint(path: string, rawText: string, portCount?: number): unknown {
  const ep = SWOS_SCHEMA[path];
  if (!ep) throw new Error(`no SwOS schema for ${path}`);
  const data = parseBlob(rawText) as unknown;
  if (ep.isArray) return decodeRecords(ep, data as unknown[], portCount);
  if (ep.genericPerPort) return decodeGenericPerPort(data as Record<string, unknown>);
  return decodeObject(ep, data as Record<string, unknown>, portCount);
}

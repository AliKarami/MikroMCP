// ---------------------------------------------------------------------------
// MikroMCP - declarative SwOS switch configuration
//
// A switch config is one document (YAML or JSON) that states the VLAN table,
// the per-port VLAN and link settings, SNMP and the system settings. Planning
// compares it with the blobs read from the switch and produces, per endpoint,
// the field changes and the mutated wire blobs to POST back, in a write order
// that never strands a port: the VLAN table only grows before the per-port
// settings change, and shrinks after them. Only fields the document names are
// touched; everything else is re-sent byte-for-byte.
//
// Pure functions only: no device I/O here, so a plan can be tested against
// fixtures and previewed before anything is written.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
  decodeEndpoint,
  dumpBlob,
  encodeLike,
  fieldFor,
  isWireHex,
  Kind,
  selectKey,
  SWOS_SCHEMA,
  LAG_MODE,
  SPEED_SWOS,
  VLAN_MODE_SWOS,
  VLAN_RECV,
  ADDR_ACQ,
  type DecodedBlob,
  type Field,
} from "../../adapter/swos-protocol.js";
import { MikroMCPError, ErrorCategory } from "../errors/error-types.js";

// ---------------------------------------------------------------------------
// Document schema
// ---------------------------------------------------------------------------

const OCTET = "(25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const IPV4_TEXT = `${OCTET}(\\.${OCTET}){3}`;
const IPV4 = new RegExp(`^${IPV4_TEXT}$`);
const CIDR = new RegExp(`^${IPV4_TEXT}(\\/(3[0-2]|[12]?\\d))?$`);

/**
 * Port bitmasks travel as one wire value of at most 32 bits, so the planner
 * handles switches of up to 32 ports (the CSS318 has 18).
 */
export const MAX_CONFIG_PORTS = 32;

const portNumber = z.number().int().min(1).max(MAX_CONFIG_PORTS);
const portList = z.array(portNumber);
// The switch strips trailing blanks when it stores a name, so a value with
// surrounding spaces could never match and would be rewritten on every apply.
const text = z
  .string()
  .max(63)
  .refine((value) => value === value.trim(), "no leading or trailing spaces");
const ipv4 = z.string().regex(IPV4, "expected a dotted IPv4 address");
const cidr = z.string().regex(CIDR, "expected an IPv4 address or CIDR, e.g. 192.168.88.0/24");

const portSchema = z
  .object({
    name: text.optional(),
    enabled: z.boolean().optional(),
    vlan_mode: z.enum(VLAN_MODE_SWOS).optional(),
    vlan_receive: z.enum(VLAN_RECV).optional(),
    default_vlan: z.number().int().min(1).max(4095).optional(),
    force_vlan: z.boolean().optional(),
    auto_negotiation: z.boolean().optional(),
    speed: z.enum(SPEED_SWOS).optional(),
    full_duplex: z.boolean().optional(),
    forward_to: portList.optional(),
    storm_rate: z.number().int().min(1).max(100).optional(),
    limit_unknown_unicast: z.boolean().optional(),
    flood_unknown_multicast: z.boolean().optional(),
    lag_mode: z.enum(LAG_MODE).optional(),
    lag_group: z.number().int().min(0).max(15).optional(),
  })
  .strict()
  // SwOS ignores a forced speed or duplex while auto-negotiation is on, so a
  // document naming one without switching negotiation off would claim a speed
  // the port does not run at.
  .refine(
    (p) => (p.speed === undefined && p.full_duplex === undefined) || p.auto_negotiation === false,
    "speed and full_duplex need auto_negotiation: false on the same port",
  );

const vlanSchema = z
  .object({
    id: z.number().int().min(1).max(4094),
    name: text.optional(),
    members: portList,
    igmp_snooping: z.boolean().optional(),
    port_isolation: z.boolean().optional(),
    learning: z.boolean().optional(),
    mirror: z.boolean().optional(),
  })
  .strict();

const systemSchema = z
  .object({
    identity: text.optional(),
    independent_vlan_lookup: z.boolean().optional(),
    igmp_snooping: z.boolean().optional(),
    igmp_querier: z.boolean().optional(),
    igmp_version: z.enum(["v2", "v3"]).optional(),
    igmp_fast_leave: portList.optional(),
    mikrotik_discovery: portList.optional(),
    dhcp_trusted_ports: portList.optional(),
    dhcp_add_information_option: z.boolean().optional(),
    address_acquisition: z.enum(ADDR_ACQ).optional(),
    static_ip: ipv4.optional(),
    allow_from: cidr.optional(),
    allow_from_ports: portList.optional(),
    allow_from_vlan: z.number().int().min(0).max(4095).optional(),
  })
  .strict();

const snmpSchema = z
  .object({
    enabled: z.boolean().optional(),
    community: text.optional(),
    contact: text.optional(),
    location: text.optional(),
  })
  .strict();

export const switchConfigSchema = z
  .object({
    version: z.literal(1),
    system: systemSchema.optional(),
    ports: z
      .record(
        z.string().regex(/^[1-9]\d?$/, "port keys are port numbers, no leading zero"),
        portSchema,
      )
      .optional(),
    vlans: z.array(vlanSchema).max(250).optional(),
    snmp: snmpSchema.optional(),
  })
  .strict();

export type SwitchConfig = z.infer<typeof switchConfigSchema>;

/**
 * System settings that change how the switch is reached. Applying them can cut
 * the session that applies them, so a plan refuses them unless asked to.
 */
export const MANAGEMENT_SETTINGS = [
  "address_acquisition",
  "static_ip",
  "allow_from",
  "allow_from_ports",
  "allow_from_vlan",
] as const;

/** Endpoints a config can touch, in the order they are written. */
export const CONFIG_ENDPOINTS = ["vlan.b", "fwd.b", "link.b", "lacp.b", "snmp.b", "sys.b"] as const;
export type ConfigEndpoint = (typeof CONFIG_ENDPOINTS)[number];

function configError(code: string, message: string, suggestedAction: string, details?: object) {
  return new MikroMCPError({
    category: ErrorCategory.VALIDATION,
    code,
    message,
    details: details as Record<string, unknown> | undefined,
    recoverability: { retryable: false, suggestedAction },
  });
}

// ---------------------------------------------------------------------------
// Parsing and secrets
// ---------------------------------------------------------------------------

const SECRET_REF = /^\$\{([A-Z0-9_]+)\}$/;

/** Paths of string values that contain a `${...}` reference. */
function secretRefs(value: unknown, path: string[] = []): string[] {
  if (typeof value === "string") return value.includes("${") ? [path.join(".")] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => secretRefs(v, [...path, String(i)]));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      secretRefs(v, [...path, k]),
    );
  }
  return [];
}

/**
 * Parse a YAML (or JSON) document or an object into a validated config.
 *
 * `snmp.community` may be a `${NAME}` reference, resolved from `secrets` (the
 * server fills them from `MIKROMCP_SECRET_<NAME>` only), so a committed config
 * never holds the community. No other field may reference a secret: a plan
 * shows the values it writes, so `identity: ${X}` would print the secret.
 * Secrets are resolved after validation, so no error message can echo one.
 */
export interface ParseOptions {
  /**
   * Refuse a literal `snmp.community` (only `${NAME}` allowed). Set for a config
   * given as text: the text goes to the audit log as it is, and only object keys
   * are redacted there.
   */
  communityByReferenceOnly?: boolean;
  /**
   * The secret names this switch may reference (its `secrets` list in
   * routers.yaml). Undefined = any configured secret.
   */
  allowedSecrets?: readonly string[];
  /** Named in the refusal when a secret is not bound to the switch. */
  routerId?: string;
}

/** What the logs hold instead of a config text that spells out a community. */
export const WITHHELD_CONFIG_TEXT =
  "<withheld: the config writes the SNMP community out or could not be parsed; reference it as ${NAME}>";

const isSecretRef = (value: unknown) => typeof value === "string" && SECRET_REF.test(value);

/** A `community` key anywhere in a parsed document whose value is not a `${NAME}` reference. */
function holdsLiteralCommunity(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(holdsLiteralCommunity);
  if (node && typeof node === "object") {
    return Object.entries(node).some(([key, value]) =>
      key.toLowerCase() === "community" ? !isSecretRef(value) : holdsLiteralCommunity(value),
    );
  }
  return false;
}

function redactCommunities(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(redactCommunities);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) =>
        key.toLowerCase() === "community" && !isSecretRef(value)
          ? [key, "<redacted>"]
          : [key, redactCommunities(value)],
      ),
    );
  }
  return node;
}

/**
 * A config as it may be logged. Text is judged on the parsed document, not by
 * pattern: YAML can spell a key in too many ways (flow maps, JSON, quoted keys,
 * block scalars, aliases) for a line match to catch. A text that holds a
 * written-out community, or that does not parse, is withheld whole.
 */
export function redactConfigParam(config: unknown): unknown {
  if (typeof config === "string") {
    let doc: unknown;
    try {
      doc = parseYaml(config, { prettyErrors: false, logLevel: "error" });
    } catch {
      return WITHHELD_CONFIG_TEXT;
    }
    return holdsLiteralCommunity(doc) ? WITHHELD_CONFIG_TEXT : config;
  }
  return redactCommunities(config);
}

export function parseSwitchConfig(
  input: unknown,
  secrets: Record<string, string> = {},
  options: ParseOptions = {},
): SwitchConfig {
  let doc: unknown = input;
  if (typeof input === "string") {
    try {
      // No pretty errors: those quote the offending source line, and a config
      // line can hold a community.
      doc = parseYaml(input, { prettyErrors: false, logLevel: "error" });
    } catch (err) {
      // The error's offset into the text, turned into a line and column.
      const offset = (err as { pos?: number[] }).pos?.[0];
      const where =
        typeof offset === "number"
          ? ` (line ${input.slice(0, offset).split("\n").length}, column ${offset - input.lastIndexOf("\n", offset - 1)})`
          : "";
      throw configError(
        "SWOS_CONFIG_PARSE_ERROR",
        `The switch config is not valid YAML${where}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        "Fix the YAML syntax and try again.",
      );
    }
  }
  const result = switchConfigSchema.safeParse(doc);
  if (!result.success) {
    throw configError(
      "SWOS_CONFIG_INVALID",
      `The switch config does not match the schema: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      "Correct the listed fields (see get_swos_config for a document in the right shape).",
      { issues: result.error.issues },
    );
  }
  const config = result.data;
  const ids = (config.vlans ?? []).map((v) => v.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw configError(
      "SWOS_CONFIG_INVALID",
      `VLAN ${duplicate} is listed more than once.`,
      "List every VLAN id once.",
    );
  }

  const misplaced = secretRefs(config).filter((path) => path !== "snmp.community");
  if (misplaced.length > 0) {
    throw configError(
      "SWOS_CONFIG_SECRET_NOT_ALLOWED",
      `Only snmp.community may reference a secret; found \${...} in ${misplaced.join(", ")}.`,
      "Write those values into the config directly.",
    );
  }
  const community = config.snmp?.community;
  if (community !== undefined && !community.includes("${") && options.communityByReferenceOnly) {
    throw configError(
      "SWOS_CONFIG_SECRET_REQUIRED",
      "snmp.community is written out in the config text; a text config is logged as it is.",
      "Put the community into MIKROMCP_SECRET_<NAME> and write snmp.community: ${NAME}, or pass the config as an object.",
    );
  }
  if (community !== undefined && community.includes("${")) {
    const match = SECRET_REF.exec(community);
    if (!match) {
      throw configError(
        "SWOS_CONFIG_INVALID",
        "snmp.community must be either a value or exactly one ${NAME} reference.",
        "Write it as ${SNMP_COMMUNITY}.",
      );
    }
    if (options.allowedSecrets && !options.allowedSecrets.includes(match[1])) {
      const who = options.routerId ? `switch "${options.routerId}"` : "this switch";
      throw configError(
        "SWOS_CONFIG_SECRET_NOT_BOUND",
        `The config references \${${match[1]}}, which is not bound to ${who} (its routers.yaml secrets list names ${options.allowedSecrets.length ? options.allowedSecrets.join(", ") : "nothing"}).`,
        `Add ${match[1]} to the switch's \`secrets\` list in routers.yaml if it is meant for it, or reference one of the bound names.`,
      );
    }
    const resolved = secrets[match[1]];
    if (resolved === undefined) {
      throw configError(
        "SWOS_CONFIG_SECRET_MISSING",
        `The config references \${${match[1]}}, but no such secret is configured.`,
        `Set MIKROMCP_SECRET_${match[1]} in the MikroMCP server's environment, or write the value into the config.`,
      );
    }
    if (resolved.length === 0 || resolved.length > 63 || resolved !== resolved.trim()) {
      throw configError(
        "SWOS_CONFIG_INVALID",
        `The secret behind \${${match[1]}} is not a usable SNMP community (1 to 63 characters, no surrounding spaces).`,
        `Fix MIKROMCP_SECRET_${match[1]}.`,
      );
    }
    return { ...config, snmp: { ...config.snmp, community: resolved } };
  }
  return config;
}

// ---------------------------------------------------------------------------
// Device facts
// ---------------------------------------------------------------------------

export type Dialect = "swos" | "swos_lite";

/** Full SwOS names its sys.b fields (`ver`); SwOS Lite numbers them (`i06`). */
export function dialectOf(sysWire: Record<string, unknown>): Dialect {
  return "ver" in sysWire || "brd" in sysWire ? "swos" : "swos_lite";
}

/** Port count from link.b: full SwOS states it (`prt`), otherwise the name list length. */
export function portCountOf(linkWire: Record<string, unknown>): number {
  const explicit = linkWire.prt;
  if (isWireHex(explicit)) return Number.parseInt(explicit, 16);
  for (const key of ["nm", "i0a"]) {
    const names = linkWire[key];
    if (Array.isArray(names)) return names.length;
  }
  throw configError(
    "SWOS_PORT_COUNT_UNKNOWN",
    "Could not determine the number of ports from link.b.",
    "Read link.b with get_swos_endpoint and report the blob.",
  );
}

// ---------------------------------------------------------------------------
// Wire encoding helpers
// ---------------------------------------------------------------------------

function maskOf(ports: readonly number[]): number {
  return ports.reduce((mask, p) => mask + 2 ** (p - 1), 0);
}

function portsOf(bits: readonly boolean[]): number[] {
  return bits.flatMap((on, i) => (on ? [i + 1] : []));
}

/** IPv4 as SwOS stores it: little-endian, first octet in the lowest byte. */
function ipToWire(ip: string): number {
  return ip
    .split(".")
    .map(Number)
    .reduce((acc, octet, i) => acc + octet * 2 ** (8 * i), 0);
}

function textToWire(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

/** Resolve a schema field and the wire key this device uses for it. */
function locate(
  endpoint: string,
  wire: Record<string, unknown>,
  fieldName: string,
): { field: Field; key: string } {
  const base = SWOS_SCHEMA[endpoint].fields.find((f) => f.name === fieldName);
  const key = base ? selectKey(base, wire) : undefined;
  if (!base || key === undefined) {
    throw configError(
      "SWOS_FIELD_NOT_ON_DEVICE",
      `${endpoint} on this switch has no "${fieldName}" field; its firmware does not expose it.`,
      "Remove the setting from the config, or read the endpoint to see what this firmware offers.",
      { endpoint, field: fieldName, keys: Object.keys(wire) },
    );
  }
  return { field: fieldFor(base, key), key };
}

function optionIndex(field: Field, value: string): number {
  const idx = (field.options ?? []).indexOf(value);
  if (idx < 0) {
    throw configError(
      "SWOS_INVALID_OPTION",
      `"${value}" is not a valid ${field.name} on this switch.`,
      `Use one of: ${(field.options ?? []).join(", ")}.`,
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface FieldChange {
  endpoint: ConfigEndpoint;
  setting: string;
  port?: number;
  vlan?: number;
  from: unknown;
  to: unknown;
}

export interface EndpointPlan {
  endpoint: ConfigEndpoint;
  changes: FieldChange[];
  /** The endpoint's final wire blob; absent when nothing changes. */
  blob?: string;
}

/** One POST, in the order the plan must be applied. */
export interface WriteStep {
  endpoint: ConfigEndpoint;
  blob: string;
  /** "grow" adds VLANs and members only; the final vlan.b write removes them. */
  phase: "grow" | "apply" | "shrink";
}

export interface ConfigPlan {
  dialect: Dialect;
  portCount: number;
  endpoints: EndpointPlan[];
  /** The POSTs that realise the plan, in order. */
  writes: WriteStep[];
  /** Changes to how the switch is reached (see MANAGEMENT_SETTINGS). */
  management: FieldChange[];
  /**
   * Ports the applied config would cut off: a strict port outside its own
   * default VLAN, an `enabled` port whose default VLAN is not in the table,
   * a port with a link that would be disabled. Any of them can be the port
   * this session uses, so applying them is gated like a management change.
   */
  warnings: string[];
}

export interface PlanOptions {
  /** Remove VLANs that are on the switch but not in the config (default true). */
  pruneVlans?: boolean;
}

/** Wire blobs read from the switch, keyed by endpoint (parsed with parseWireBlob). */
export type CurrentBlobs = Partial<Record<ConfigEndpoint, unknown>>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkPorts(where: string, ports: readonly number[], portCount: number): void {
  const bad = ports.filter((p) => p > portCount);
  if (bad.length > 0) {
    throw configError(
      "SWOS_CONFIG_INVALID",
      `${where} names port(s) ${bad.join(", ")}, but this switch has ${portCount} ports.`,
      `Use port numbers 1 to ${portCount}.`,
    );
  }
}

/**
 * Speeds a port may be forced to. SwOS 2.19 dropped forced copper speeds above
 * 100M ("removed unsupported forced copper speeds above 100M"); the SFP+ cages
 * run 1G to 10G.
 */
const FORCED_SPEEDS = {
  copper: ["10M", "100M"],
  sfp: ["1G", "2.5G", "5G", "10G"],
} as const;

/** 1-based ports that are SFP cages, from link.b's `sfp` (count) and `sfpo` (0-based offset). */
function sfpPorts(linkWire: Record<string, unknown>): Set<number> | undefined {
  const count = linkWire.sfp;
  const offset = linkWire.sfpo;
  if (!isWireHex(count) || !isWireHex(offset)) return undefined;
  const first = Number.parseInt(offset, 16) + 1;
  return new Set(Array.from({ length: Number.parseInt(count, 16) }, (_, i) => first + i));
}

function checkForcedSpeed(port: number, speed: string, cages: Set<number> | undefined): void {
  if (!cages) return;
  const kind = cages.has(port) ? "sfp" : "copper";
  const allowed: readonly string[] = FORCED_SPEEDS[kind];
  if (!allowed.includes(speed)) {
    throw configError(
      "SWOS_CONFIG_INVALID",
      `Port ${port} is ${kind === "sfp" ? "an SFP+ cage" : "a copper port"} and cannot be forced to ${speed}.`,
      `Force it to one of ${allowed.join(", ")}, or leave auto_negotiation on.`,
    );
  }
}

/** Collects field changes for one non-record endpoint and mutates its wire copy. */
class ObjectEndpointPlanner {
  readonly changes: FieldChange[] = [];
  readonly wire: DecodedBlob;
  private readonly decoded: Record<string, unknown>;

  constructor(
    readonly endpoint: ConfigEndpoint,
    current: unknown,
    readonly portCount: number,
  ) {
    this.wire = structuredClone(current) as DecodedBlob;
    this.decoded = decodeEndpoint(endpoint, dumpBlob(current), portCount) as Record<
      string,
      unknown
    >;
  }

  scalar(setting: string, fieldName: string, desired: unknown): void {
    const { field, key } = locate(this.endpoint, this.wire, fieldName);
    const current = this.decoded[field.name];
    if (same(current, desired)) return;
    const existing = this.wire[key];
    let next: unknown;
    switch (field.kind) {
      case Kind.CHECKBOX:
        next = encodeLike(desired ? 1 : 0, existing);
        break;
      case Kind.OPTION:
        next = encodeLike(optionIndex(field, String(desired)), existing);
        break;
      case Kind.STR:
        next = textToWire(String(desired));
        break;
      case Kind.IP:
        next = encodeLike(ipToWire(String(desired)), existing);
        break;
      default:
        next = encodeLike(Number(desired), existing);
    }
    this.wire[key] = next;
    this.changes.push({ endpoint: this.endpoint, setting, from: current, to: desired });
  }

  ports(setting: string, fieldName: string, desired: readonly number[]): void {
    checkPorts(setting, desired, this.portCount);
    const { field, key } = locate(this.endpoint, this.wire, fieldName);
    const current = portsOf((this.decoded[field.name] as boolean[] | undefined) ?? []);
    const want = [...new Set(desired)].sort((a, b) => a - b);
    if (same(current, want)) return;
    this.wire[key] = encodeLike(maskOf(want), this.wire[key]);
    this.changes.push({ endpoint: this.endpoint, setting, from: current, to: want });
  }

  /** One port's entry of a per-port field (array or bitmask). */
  port(setting: string, fieldName: string, port: number, desired: unknown): void {
    const { field, key } = locate(this.endpoint, this.wire, fieldName);
    const decodedValue = this.decoded[field.name];
    const current = Array.isArray(decodedValue) ? decodedValue[port - 1] : undefined;
    if (same(current, desired)) return;
    const existing = this.wire[key];

    if (Array.isArray(existing)) {
      const items = [...existing];
      const old = items[port - 1];
      if (field.kind === Kind.STR) items[port - 1] = textToWire(String(desired));
      else if (field.kind === Kind.OPTION)
        items[port - 1] = encodeLike(optionIndex(field, String(desired)), old);
      else items[port - 1] = encodeLike(Number(desired), old);
      this.wire[key] = items;
    } else if (field.kind === Kind.BOOL && isWireHex(existing)) {
      const mask = Number.parseInt(existing, 16);
      const bit = 2 ** (port - 1);
      const has = Math.floor(mask / bit) % 2 === 1;
      const next = desired ? (has ? mask : mask + bit) : has ? mask - bit : mask;
      this.wire[key] = encodeLike(next, existing);
    } else {
      throw configError(
        "SWOS_FIELD_SHAPE_MISMATCH",
        `${this.endpoint} ${field.name} is not a per-port field on this switch.`,
        "Read the endpoint and report the blob.",
      );
    }
    this.changes.push({ endpoint: this.endpoint, setting, port, from: current, to: desired });
  }

  result(): EndpointPlan {
    return this.changes.length > 0
      ? { endpoint: this.endpoint, changes: this.changes, blob: dumpBlob(this.wire) }
      : { endpoint: this.endpoint, changes: [] };
  }
}

interface VlanRow {
  vid: number;
  name: string;
  members: number[];
  igmp: boolean;
  port_isolation: boolean;
  learning: boolean;
  mirror: boolean;
}

interface VlanTablePlan {
  plan: EndpointPlan;
  /** Blob of the add-only first write, when the final table also removes something. */
  grow?: string;
  /** The final table removes a VLAN or a member, so it must be written after the per-port settings. */
  shrinks: boolean;
  /** VLAN id -> member ports once the plan is applied. */
  members: Map<number, Set<number>>;
}

function planVlanTable(
  current: unknown,
  desired: NonNullable<SwitchConfig["vlans"]>,
  portCount: number,
  prune: boolean,
): VlanTablePlan {
  const wireRows = structuredClone(current) as Record<string, unknown>[];
  const decodedRows = decodeEndpoint("vlan.b", dumpBlob(current), portCount) as Record<
    string,
    unknown
  >[];
  const rowsByVid = new Map<number, { wire: Record<string, unknown>; row: VlanRow }>();
  decodedRows.forEach((d, i) => {
    rowsByVid.set(Number(d.vid), {
      wire: wireRows[i],
      row: {
        vid: Number(d.vid),
        name: String(d.name ?? ""),
        members: portsOf((d.members as boolean[] | undefined) ?? []),
        igmp: Boolean(d.igmp),
        port_isolation: Boolean(d.port_isolation),
        learning: Boolean(d.learning),
        mirror: Boolean(d.mirror),
      },
    });
  });

  // Width of a new row's member mask: what existing rows use, else enough hex
  // digits for every port, rounded up to whole bytes as the firmware writes them.
  const sampleMask = wireRows.find((r) => isWireHex(r.mbr))?.mbr as string | undefined;
  const maskTemplate = sampleMask ?? `0x${"0".repeat(Math.ceil(portCount / 8) * 2)}`;

  const changes: FieldChange[] = [];
  const finalRows: { vid: number; wire: Record<string, unknown> }[] = [];
  const growRows: { vid: number; wire: Record<string, unknown> }[] = [];
  const members = new Map<number, Set<number>>();
  let shrinks = false;

  for (const vlan of [...desired].sort((a, b) => a.id - b.id)) {
    checkPorts(`VLAN ${vlan.id} members`, vlan.members, portCount);
    const wantMembers = [...new Set(vlan.members)].sort((a, b) => a - b);
    members.set(vlan.id, new Set(wantMembers));
    const existing = rowsByVid.get(vlan.id);

    if (!existing) {
      // A new VLAN gets the web UI's defaults for whatever the document omits.
      const row: VlanRow = {
        vid: vlan.id,
        name: vlan.name ?? "",
        members: wantMembers,
        igmp: vlan.igmp_snooping ?? false,
        port_isolation: vlan.port_isolation ?? true,
        learning: vlan.learning ?? true,
        mirror: vlan.mirror ?? false,
      };
      const wire = {
        vid: encodeLike(vlan.id, "0x0000"),
        nm: textToWire(row.name),
        piso: encodeLike(row.port_isolation ? 1 : 0, "0x00"),
        lrn: encodeLike(row.learning ? 1 : 0, "0x00"),
        mrr: encodeLike(row.mirror ? 1 : 0, "0x00"),
        igmp: encodeLike(row.igmp ? 1 : 0, "0x00"),
        mbr: encodeLike(maskOf(wantMembers), maskTemplate),
      };
      finalRows.push({ vid: vlan.id, wire });
      growRows.push({ vid: vlan.id, wire });
      changes.push({ endpoint: "vlan.b", setting: "add", vlan: vlan.id, from: null, to: row });
      continue;
    }

    // An existing VLAN changes only in what the document names.
    const row = { ...existing.wire };
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const flag = (key: string, name: keyof VlanRow, want: boolean | undefined) => {
      if (want === undefined || existing.row[name] === want) return;
      row[key] = encodeLike(want ? 1 : 0, row[key]);
      diff[name] = { from: existing.row[name], to: want };
    };
    if (vlan.name !== undefined && existing.row.name !== vlan.name) {
      row.nm = textToWire(vlan.name);
      diff.name = { from: existing.row.name, to: vlan.name };
    }
    flag("igmp", "igmp", vlan.igmp_snooping);
    flag("piso", "port_isolation", vlan.port_isolation);
    flag("lrn", "learning", vlan.learning);
    flag("mrr", "mirror", vlan.mirror);
    const grow = { ...row };
    if (!same(existing.row.members, wantMembers)) {
      row.mbr = encodeLike(maskOf(wantMembers), row.mbr);
      diff.members = { from: existing.row.members, to: wantMembers };
      const union = [...new Set([...existing.row.members, ...wantMembers])].sort((a, b) => a - b);
      grow.mbr = encodeLike(maskOf(union), grow.mbr);
      if (union.length > wantMembers.length) shrinks = true;
    }
    for (const [setting, c] of Object.entries(diff)) {
      changes.push({ endpoint: "vlan.b", setting, vlan: vlan.id, from: c.from, to: c.to });
    }
    finalRows.push({ vid: vlan.id, wire: row });
    growRows.push({ vid: vlan.id, wire: grow });
  }

  const wanted = new Set(desired.map((v) => v.id));
  for (const [vid, { wire, row }] of rowsByVid) {
    if (wanted.has(vid)) continue;
    growRows.push({ vid, wire });
    if (prune) {
      shrinks = true;
      changes.push({ endpoint: "vlan.b", setting: "remove", vlan: vid, from: row, to: null });
    } else {
      finalRows.push({ vid, wire });
      members.set(vid, new Set(row.members));
    }
  }

  const byVid = (a: { vid: number }, b: { vid: number }) => a.vid - b.vid;
  const finalBlob = dumpBlob(finalRows.sort(byVid).map((r) => r.wire));
  const growBlob = dumpBlob(growRows.sort(byVid).map((r) => r.wire));
  if (changes.length === 0) {
    return { plan: { endpoint: "vlan.b", changes: [] }, shrinks: false, members };
  }
  return {
    plan: { endpoint: "vlan.b", changes, blob: finalBlob },
    // No grow write when nothing is added: the current table already holds everything.
    grow: shrinks && growBlob !== dumpBlob(current) ? growBlob : undefined,
    shrinks,
    members,
  };
}

interface PortState {
  enabled: boolean;
  link: boolean;
  mode: string;
  receive: string;
  dvid: number;
  /** Force VLAN ID: every frame, tagged or not, is put into the default VLAN. */
  forceVid: boolean;
  autoNeg: boolean;
  speed: string;
  fullDuplex: boolean;
  /** Ports this port may forward to (its Port Isolation row). */
  forwardTo: number[];
  lagMode: string;
  lagGroup: number;
}

/** Whether the link would renegotiate: auto-negotiation switched, or a forced value changed. */
function renegotiates(before: PortState, after: PortState): boolean {
  if (before.autoNeg !== after.autoNeg) return true;
  return !after.autoNeg && (before.speed !== after.speed || before.fullDuplex !== after.fullDuplex);
}

/** How management access is restricted once the plan is applied (sys.b allow-from). */
interface ManagementAccess {
  /** 0 = any VLAN. */
  vlan: number;
  /** Ports management is allowed from. */
  ports: number[];
}

/**
 * Management cut off by a VLAN table: the allow-from VLAN gone, or a linked
 * allow-from port no longer in it. `link` says which ports have a link.
 */
function managementRisks(
  management: ManagementAccess | undefined,
  members: Map<number, Set<number>>,
  link: PortState[],
): string[] {
  if (!management || management.vlan <= 0) return [];
  const vlanMembers = members.get(management.vlan);
  if (!vlanMembers) {
    return [
      `Management is allowed from VLAN ${management.vlan} only, which would no longer be in the VLAN table.`,
    ];
  }
  const out = management.ports.filter((p) => link[p - 1]?.link && !vlanMembers.has(p));
  return out.length > 0
    ? [
        `Management is allowed from VLAN ${management.vlan} only, and linked port(s) ${out.join(", ")} would not be members of it.`,
      ]
    : [];
}

/**
 * Linked ports whose untagged traffic a VLAN table drops: a strict port that
 * is not a member of its own default VLAN, or a filtering port whose default
 * VLAN is not in the table. `link` says which ports have a link.
 */
function untaggedRisks(
  ports: PortState[],
  members: Map<number, Set<number>>,
  link: PortState[],
): string[] {
  const risks: string[] = [];
  ports.forEach((port, i) => {
    const n = i + 1;
    if (!link[i]?.link || !port.enabled || port.receive === "only_tagged") return;
    if (port.mode === "strict" && !members.get(port.dvid)?.has(n)) {
      risks.push(
        `Port ${n} is strict with default VLAN ${port.dvid}, but is not a member of VLAN ${port.dvid}: its untagged traffic will be dropped.`,
      );
    } else if (port.mode === "enabled" && !members.has(port.dvid)) {
      risks.push(
        `Port ${n} filters VLANs with default VLAN ${port.dvid}, which is not in the VLAN table: its untagged traffic will be dropped.`,
      );
    }
  });
  return risks;
}

/**
 * Ports the applied config would cut off, judged on the switch's state after
 * the whole plan, settings the document leaves out included. Only ports with a
 * link count (nobody is behind the others), and only risks the plan introduces:
 * a problem the switch already has today is not a reason to refuse an
 * unrelated change. Whether a port is a trunk is judged from its state before
 * the plan, so turning a trunk into an access port is seen for what it is.
 */
function lockoutRisks(
  before: PortState[],
  after: PortState[],
  membersBefore: Map<number, Set<number>>,
  members: Map<number, Set<number>>,
  managementBefore?: ManagementAccess,
  managementAfter?: ManagementAccess,
): string[] {
  const introduced = (now: string[], already: string[]) =>
    now.filter((risk) => !already.includes(risk));
  const risks: string[] = introduced(
    managementRisks(managementAfter, members, before),
    managementRisks(managementBefore, membersBefore, before),
  );
  // Management is reached through an allow-from port with a link; a list that
  // keeps none of them (or no port at all) cuts every session off.
  const allowFromPortRisks = (m: ManagementAccess | undefined): string[] => {
    if (!m || m.ports.some((p) => before[p - 1]?.link)) return [];
    return [
      m.ports.length === 0
        ? "Management would be allowed from no port at all."
        : `Management would be allowed from port(s) ${m.ports.join(", ")} only, none of which has a link.`,
    ];
  };
  risks.push(
    ...introduced(allowFromPortRisks(managementAfter), allowFromPortRisks(managementBefore)),
  );
  const allowFrom = (n: number) =>
    managementAfter !== undefined && managementAfter.vlan > 0 && managementAfter.ports.includes(n);
  after.forEach((port, i) => {
    const was = before[i];
    if (!was?.link) return;
    const n = i + 1;
    const live = was.enabled && port.enabled && port.mode !== "disabled";
    if (was.receive !== "only_tagged" && port.receive === "only_tagged") {
      risks.push(
        `Port ${n} has a link and would accept tagged frames only; untagged traffic on it, management included, is dropped.`,
      );
    }
    // A trunk is a port that takes tagged frames today; it loses the tagged
    // VLANs it is taken out of, pruned ones included, and all of them when it
    // becomes an access port. Its default VLAN carries the untagged traffic
    // and is judged separately, but only on a port that accepts untagged
    // frames: on a tagged-only port the default VLAN is carried tagged too.
    const trunk = was.enabled && was.mode !== "disabled" && was.receive !== "only_untagged";
    if (trunk && live) {
      const untaggedVid = (state: PortState) =>
        state.receive === "only_tagged" ? undefined : state.dvid;
      const carried = [...membersBefore.entries()]
        .filter(([, ports]) => ports.has(n))
        .map(([vid]) => vid)
        .filter((vid) => vid !== untaggedVid(port) && vid !== untaggedVid(was));
      if (port.receive === "only_untagged") {
        if (carried.length > 0) {
          risks.push(
            `Port ${n} has a link and would accept untagged frames only; tagged traffic in VLAN(s) ${carried.join(", ")} stops on this port.`,
          );
        }
      } else {
        const lost = carried.filter((vid) => !members.get(vid)?.has(n));
        if (lost.length > 0) {
          risks.push(
            `Port ${n} has a link and would leave VLAN(s) ${lost.join(", ")}; tagged traffic in them stops on this port.`,
          );
        }
      }
    }
    // Where untagged traffic lands: a moved default VLAN or a forced VLAN, on a
    // port somebody is behind. (Whether the new VLAN then drops it is judged by
    // untaggedRisks below.)
    if (live && port.receive !== "only_tagged" && was.dvid !== port.dvid) {
      const note = allowFrom(n)
        ? "; management is allowed from this port"
        : managementAfter && managementAfter.vlan > 0 && was.dvid === managementAfter.vlan
          ? "; VLAN " + was.dvid + " is the management VLAN"
          : "";
      risks.push(
        `Port ${n} has a link and its untagged traffic would move from VLAN ${was.dvid} to VLAN ${port.dvid}${note}.`,
      );
    }
    // A port whose VLAN mode leaves `disabled` starts filtering: frames in
    // VLANs it is not a member of stop, tagged management traffic included.
    if (live && was.mode === "disabled" && port.mode !== "disabled") {
      risks.push(
        `Port ${n} has a link and would start filtering VLANs (${port.mode}); traffic in VLANs it is not a member of stops on this port.`,
      );
    }
    if (live && !was.forceVid && port.forceVid) {
      risks.push(
        `Port ${n} has a link and would force every frame into VLAN ${port.dvid}; tagged traffic on it, management included, is re-tagged.`,
      );
    }
    if (was.enabled && !port.enabled) {
      risks.push(`Port ${n} has a link and would be disabled.`);
    } else if (was.enabled && renegotiates(was, port)) {
      risks.push(
        `Port ${n} has a link and its negotiation would change; the link drops and may not come back.`,
      );
    }
    if (port.enabled) {
      const cut = was.forwardTo.filter((m) => before[m - 1]?.link && !port.forwardTo.includes(m));
      if (cut.length > 0) {
        risks.push(
          `Port ${n} has a link and would stop forwarding to linked port(s) ${cut.join(", ")}.`,
        );
      }
      if (was.lagMode !== port.lagMode || was.lagGroup !== port.lagGroup) {
        risks.push(
          `Port ${n} has a link and its link aggregation would change; it stops forwarding until the other end matches.`,
        );
      }
    }
  });
  risks.push(
    ...introduced(
      untaggedRisks(after, members, before),
      untaggedRisks(before, membersBefore, before),
    ),
  );
  return risks;
}

function portStates(
  link: Record<string, unknown>,
  fwd: Record<string, unknown> | undefined,
  lacp: Record<string, unknown> | undefined,
  portCount: number,
): PortState[] {
  const at = (field: unknown, i: number) => (Array.isArray(field) ? field[i] : undefined);
  const everyOther = (i: number) =>
    Array.from({ length: portCount }, (_, k) => k + 1).filter((p) => p !== i + 1);
  return Array.from({ length: portCount }, (_, i) => ({
    enabled: at(link.enabled, i) !== false,
    link: at(link.link, i) === true,
    mode: String(at(fwd?.vlan_mode, i) ?? "optional"),
    receive: String(at(fwd?.vlan_recv_mode, i) ?? "any"),
    dvid: Number(at(fwd?.default_vid, i) ?? 1),
    forceVid: at(fwd?.force_vid, i) === true,
    autoNeg: at(link.auto_neg, i) !== false,
    speed: String(at(link.manual_speed, i) ?? ""),
    fullDuplex: at(link.manual_duplex, i) !== false,
    forwardTo: Array.isArray(fwd?.[`isolation_p${i + 1}`])
      ? portsOf(fwd[`isolation_p${i + 1}`] as boolean[])
      : everyOther(i),
    lagMode: String(at(lacp?.mode, i) ?? "passive"),
    lagGroup: Number(at(lacp?.group, i) ?? 0),
  }));
}

/**
 * Compare a config with the switch's current blobs and produce the per-endpoint
 * changes and blobs to write. `current` must hold link.b and sys.b (port count
 * and dialect) plus every endpoint the config touches.
 */
export function planSwitchConfig(
  config: SwitchConfig,
  current: CurrentBlobs,
  options: PlanOptions = {},
): ConfigPlan {
  const link = current["link.b"] as Record<string, unknown> | undefined;
  const sys = current["sys.b"] as Record<string, unknown> | undefined;
  if (!link || !sys) {
    throw configError(
      "SWOS_PLAN_INPUT_MISSING",
      "Planning a switch config needs the switch's current link.b and sys.b blobs.",
      "Read link.b and sys.b from the switch before planning.",
    );
  }
  const dialect = dialectOf(sys);
  const portCount = portCountOf(link);
  if (portCount > MAX_CONFIG_PORTS) {
    throw configError(
      "SWOS_PORT_COUNT_UNSUPPORTED",
      `This switch has ${portCount} ports; switch configs support up to ${MAX_CONFIG_PORTS}.`,
      "Configure this switch with write_swos_blob or in the web UI.",
    );
  }
  const endpoints: EndpointPlan[] = [];

  const decodeCurrent = (ep: ConfigEndpoint) =>
    current[ep] === undefined
      ? undefined
      : (decodeEndpoint(ep, dumpBlob(current[ep]), portCount) as Record<string, unknown>);

  // vlan.b
  const membersBefore = new Map<number, Set<number>>();
  for (const r of (decodeCurrent("vlan.b") as unknown as Record<string, unknown>[]) ?? []) {
    membersBefore.set(Number(r.vid), new Set(portsOf((r.members as boolean[]) ?? [])));
  }
  let members = membersBefore;
  let vlanGrow: string | undefined;
  let vlanShrinks = false;
  if (config.vlans) {
    if (dialect !== "swos") {
      throw configError(
        "SWOS_VLAN_TABLE_UNSUPPORTED",
        "Writing the VLAN table is only supported on full SwOS; SwOS Lite's vlan.b keys are unverified.",
        "Remove `vlans` from the config for this switch, or set the table in the web UI.",
      );
    }
    const table = planVlanTable(
      current["vlan.b"] ?? [],
      config.vlans,
      portCount,
      options.pruneVlans ?? true,
    );
    endpoints.push(table.plan);
    vlanGrow = table.grow;
    vlanShrinks = table.shrinks;
    members = table.members;
  }

  // fwd.b
  if (config.ports && Object.values(config.ports).some((p) => hasFwdSettings(p))) {
    const fwd = new ObjectEndpointPlanner("fwd.b", current["fwd.b"], portCount);
    for (const [key, port] of sortedPorts(config.ports, portCount)) {
      if (port.vlan_mode !== undefined) fwd.port("vlan_mode", "vlan_mode", key, port.vlan_mode);
      if (port.vlan_receive !== undefined)
        fwd.port("vlan_receive", "vlan_recv_mode", key, port.vlan_receive);
      if (port.default_vlan !== undefined)
        fwd.port("default_vlan", "default_vid", key, port.default_vlan);
      if (port.force_vlan !== undefined) fwd.port("force_vlan", "force_vid", key, port.force_vlan);
      // A port never forwards to itself; the factory masks leave that bit clear.
      if (port.forward_to !== undefined)
        fwd.ports(
          `port ${key} forward_to`,
          `isolation_p${key}`,
          port.forward_to.filter((p) => p !== key),
        );
      if (port.storm_rate !== undefined) {
        fullSwosOnly(dialect, "storm_rate");
        fwd.port("storm_rate", "storm_rate", key, port.storm_rate);
      }
      if (port.limit_unknown_unicast !== undefined)
        fwd.port("limit_unknown_unicast", "limit_unknown_ucast", key, port.limit_unknown_unicast);
      if (port.flood_unknown_multicast !== undefined)
        fwd.port(
          "flood_unknown_multicast",
          "flood_unknown_mcast",
          key,
          port.flood_unknown_multicast,
        );
    }
    endpoints.push(fwd.result());
  }

  // link.b
  if (config.ports && Object.values(config.ports).some((p) => hasLinkSettings(p))) {
    const linkPlan = new ObjectEndpointPlanner("link.b", link, portCount);
    const cages = sfpPorts(link);
    for (const [key, port] of sortedPorts(config.ports, portCount)) {
      if (port.name !== undefined) linkPlan.port("name", "name", key, port.name);
      if (port.enabled !== undefined) linkPlan.port("enabled", "enabled", key, port.enabled);
      if (port.auto_negotiation !== undefined)
        linkPlan.port("auto_negotiation", "auto_neg", key, port.auto_negotiation);
      if (port.speed !== undefined) {
        checkForcedSpeed(key, port.speed, cages);
        linkPlan.port("speed", "manual_speed", key, port.speed);
      }
      if (port.full_duplex !== undefined)
        linkPlan.port("full_duplex", "manual_duplex", key, port.full_duplex);
    }
    endpoints.push(linkPlan.result());
  }

  // lacp.b
  if (
    config.ports &&
    Object.values(config.ports).some((p) => p.lag_mode !== undefined || p.lag_group !== undefined)
  ) {
    fullSwosOnly(dialect, "lag_mode and lag_group");
    const lacp = new ObjectEndpointPlanner("lacp.b", current["lacp.b"], portCount);
    for (const [key, port] of sortedPorts(config.ports, portCount)) {
      if (port.lag_mode !== undefined) lacp.port("lag_mode", "mode", key, port.lag_mode);
      if (port.lag_group !== undefined) lacp.port("lag_group", "group", key, port.lag_group);
    }
    endpoints.push(lacp.result());
  }

  // snmp.b
  if (config.snmp) {
    const snmp = new ObjectEndpointPlanner("snmp.b", current["snmp.b"], portCount);
    const s = config.snmp;
    if (s.enabled !== undefined) snmp.scalar("snmp.enabled", "enabled", s.enabled);
    if (s.community !== undefined) snmp.scalar("snmp.community", "community", s.community);
    if (s.contact !== undefined) snmp.scalar("snmp.contact", "contact", s.contact);
    if (s.location !== undefined) snmp.scalar("snmp.location", "location", s.location);
    endpoints.push(redactCommunity(snmp.result()));
  }

  // sys.b
  const management: FieldChange[] = [];
  if (config.system) {
    const sysPlan = new ObjectEndpointPlanner("sys.b", sys, portCount);
    const s = config.system;
    if (s.identity !== undefined) sysPlan.scalar("identity", "identity", s.identity);
    if (s.independent_vlan_lookup !== undefined)
      sysPlan.scalar(
        "independent_vlan_lookup",
        "independent_vlan_lookup",
        s.independent_vlan_lookup,
      );
    if (s.igmp_snooping !== undefined)
      sysPlan.scalar("igmp_snooping", "igmp_snooping", s.igmp_snooping);
    if (s.igmp_querier !== undefined)
      sysPlan.scalar("igmp_querier", "igmp_querier", s.igmp_querier);
    if (s.igmp_version !== undefined)
      sysPlan.scalar("igmp_version", "igmp_version", s.igmp_version);
    if (s.igmp_fast_leave !== undefined)
      sysPlan.ports("igmp_fast_leave", "igmp_fast_leave", s.igmp_fast_leave);
    if (s.mikrotik_discovery !== undefined)
      sysPlan.ports("mikrotik_discovery", "discovery_protocol", s.mikrotik_discovery);
    if (s.dhcp_trusted_ports !== undefined)
      sysPlan.ports("dhcp_trusted_ports", "dhcp_trusted_ports", s.dhcp_trusted_ports);
    if (s.dhcp_add_information_option !== undefined)
      sysPlan.scalar(
        "dhcp_add_information_option",
        "dhcp_info_option",
        s.dhcp_add_information_option,
      );

    const before = sysPlan.changes.length;
    if (s.address_acquisition !== undefined)
      sysPlan.scalar("address_acquisition", "addr_acq", s.address_acquisition);
    if (s.static_ip !== undefined) sysPlan.scalar("static_ip", "static_ip", s.static_ip);
    if (s.allow_from !== undefined) {
      const [ip, bits] = s.allow_from.split("/");
      sysPlan.scalar("allow_from", "allow_from_ip", ip);
      sysPlan.scalar("allow_from", "allow_from_mask", Number(bits ?? "32"));
    }
    if (s.allow_from_ports !== undefined)
      sysPlan.ports("allow_from_ports", "allow_from_ports", s.allow_from_ports);
    if (s.allow_from_vlan !== undefined)
      sysPlan.scalar("allow_from_vlan", "allow_from_vlan", s.allow_from_vlan);
    management.push(...sysPlan.changes.slice(before));
    endpoints.push(sysPlan.result());
  }

  const ordered = CONFIG_ENDPOINTS.flatMap((ep) => endpoints.filter((p) => p.endpoint === ep));
  const blobOf = (ep: ConfigEndpoint) => ordered.find((p) => p.endpoint === ep)?.blob;

  // Write order: the VLAN table grows first (adds and new members only), the
  // per-port settings follow, and only then does the table shrink. At no point
  // is a port's default VLAN missing from the table or from its membership.
  const writes: WriteStep[] = [];
  const vlanFinal = blobOf("vlan.b");
  if (vlanFinal !== undefined && !vlanShrinks) {
    writes.push({ endpoint: "vlan.b", blob: vlanFinal, phase: "grow" });
  } else if (vlanGrow !== undefined) {
    writes.push({ endpoint: "vlan.b", blob: vlanGrow, phase: "grow" });
  }
  for (const ep of ["fwd.b", "link.b", "lacp.b", "snmp.b"] as const) {
    const blob = blobOf(ep);
    if (blob !== undefined) writes.push({ endpoint: ep, blob, phase: "apply" });
  }
  // A table that removes anything is written only after the per-port settings,
  // whether or not a grow write came first.
  if (vlanFinal !== undefined && vlanShrinks) {
    writes.push({ endpoint: "vlan.b", blob: vlanFinal, phase: "shrink" });
  }
  const sysBlob = blobOf("sys.b");
  if (sysBlob !== undefined) writes.push({ endpoint: "sys.b", blob: sysBlob, phase: "apply" });

  // Lockout check on the state after the whole plan, unlisted settings included.
  const fwdBefore = decodeCurrent("fwd.b");
  const linkBefore = decodeCurrent("link.b") ?? {};
  const lacpBefore = decodeCurrent("lacp.b");
  const fwdAfterBlob = blobOf("fwd.b");
  const linkAfterBlob = blobOf("link.b");
  const lacpAfterBlob = blobOf("lacp.b");
  const lacpAfter = lacpAfterBlob
    ? (decodeEndpoint("lacp.b", lacpAfterBlob, portCount) as Record<string, unknown>)
    : lacpBefore;
  const fwdAfter = fwdAfterBlob
    ? (decodeEndpoint("fwd.b", fwdAfterBlob, portCount) as Record<string, unknown>)
    : fwdBefore;
  const linkAfter = linkAfterBlob
    ? (decodeEndpoint("link.b", linkAfterBlob, portCount) as Record<string, unknown>)
    : linkBefore;
  const sysBefore = decodeCurrent("sys.b") ?? {};
  const sysAfter = sysBlob
    ? (decodeEndpoint("sys.b", sysBlob, portCount) as Record<string, unknown>)
    : sysBefore;
  const managementOf = (sys: Record<string, unknown>): ManagementAccess | undefined =>
    typeof sys.allow_from_vlan === "number"
      ? {
          vlan: sys.allow_from_vlan,
          ports: Array.isArray(sys.allow_from_ports)
            ? portsOf(sys.allow_from_ports as boolean[])
            : [],
        }
      : undefined;
  const warnings = lockoutRisks(
    portStates(linkBefore, fwdBefore, lacpBefore, portCount),
    portStates(linkAfter, fwdAfter, lacpAfter, portCount),
    membersBefore,
    members,
    managementOf(sysBefore),
    managementOf(sysAfter),
  );

  return { dialect, portCount, endpoints: ordered, writes, management, warnings };
}

function hasLinkSettings(p: z.infer<typeof portSchema>): boolean {
  return (
    p.name !== undefined ||
    p.enabled !== undefined ||
    p.auto_negotiation !== undefined ||
    p.speed !== undefined ||
    p.full_duplex !== undefined
  );
}

function hasFwdSettings(p: z.infer<typeof portSchema>): boolean {
  return (
    p.vlan_mode !== undefined ||
    p.vlan_receive !== undefined ||
    p.default_vlan !== undefined ||
    p.force_vlan !== undefined ||
    p.forward_to !== undefined ||
    p.storm_rate !== undefined ||
    p.limit_unknown_unicast !== undefined ||
    p.flood_unknown_multicast !== undefined
  );
}

/** Settings whose SwOS Lite encoding differs (units, keys) and is not mapped. */
function fullSwosOnly(dialect: Dialect, what: string): void {
  if (dialect === "swos") return;
  throw configError(
    "SWOS_SETTING_UNSUPPORTED",
    `${what} can only be set on full SwOS; SwOS Lite encodes it differently.`,
    `Remove ${what} from the config for this switch, or set it in the web UI.`,
  );
}

function sortedPorts(
  ports: NonNullable<SwitchConfig["ports"]>,
  portCount: number,
): [number, z.infer<typeof portSchema>][] {
  const entries = Object.entries(ports).map(([k, v]) => [Number(k), v] as [number, typeof v]);
  checkPorts(
    "ports",
    entries.map(([n]) => n),
    portCount,
  );
  return entries.sort((a, b) => a[0] - b[0]);
}

/** The community is a credential: plans name the change but never show the value. */
function redactCommunity(plan: EndpointPlan): EndpointPlan {
  return {
    ...plan,
    changes: plan.changes.map((c) =>
      c.setting === "snmp.community" ? { ...c, from: "<redacted>", to: "<redacted>" } : c,
    ),
  };
}

/**
 * The VLAN table holding every VLAN of both tables, each with the members of
 * both. Restoring an old table over a newer one goes through this first, so no
 * port loses its default VLAN between the table write and the per-port writes.
 */
export function unionVlanBlob(currentWire: unknown, targetWire: unknown): string {
  const rows = new Map<number, Record<string, unknown>>();
  const vidOf = (row: Record<string, unknown>) => Number.parseInt(String(row.vid), 16);
  for (const row of targetWire as Record<string, unknown>[]) rows.set(vidOf(row), { ...row });
  for (const row of currentWire as Record<string, unknown>[]) {
    const kept = rows.get(vidOf(row));
    if (!kept) {
      rows.set(vidOf(row), { ...row });
    } else if (isWireHex(kept.mbr) && isWireHex(row.mbr)) {
      // BigInt: a 32-port mask does not survive JS's signed 32-bit `|`.
      const union = Number(BigInt(kept.mbr) | BigInt(row.mbr));
      kept.mbr = encodeLike(union, kept.mbr);
    }
  }
  return dumpBlob([...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row));
}

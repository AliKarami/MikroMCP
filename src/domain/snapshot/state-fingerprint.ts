import { createHash } from "node:crypto";
import type { DeviceClient } from "../../adapter/connection-pool.js";
import { SwosClient } from "../../adapter/swos-client.js";
import type { RouterOSRecord, RouterOSValue } from "../../types.js";
import { isTrue } from "../../adapter/response-parser.js";
import type { DynamicTargets, ToolDefinition } from "../tools/tool-definition.js";
import { statePathsFor } from "../tools/tool-definition.js";
import { RUNTIME_FIELDS } from "./diff-engine.js";

/** Fingerprint of a call that reads no state: nothing to bind, so it always matches. */
export const NO_STATE_FINGERPRINT = "none";

/**
 * Paths whose whole content changes on its own, so a hash of it could never
 * match a minute later. A confirmation for a write there binds nothing.
 */
const UNBOUND_PATHS: ReadonlySet<string> = new Set(["system/clock"]);

/**
 * Status and counter fields, beyond the diff engine's RUNTIME_FIELDS, that the
 * router updates by itself. They are not configuration, and leaving them in
 * would make a fingerprint taken a few seconds later differ without anyone
 * touching the router. Per path, because the same name is configuration
 * elsewhere (`address` on ip/address, `status` nowhere in config but runtime on
 * several menus).
 */
const VOLATILE_FIELDS_BY_PATH: Record<string, readonly string[]> = {
  // A dynamic-timeout entry reports the time it has left, which counts down.
  "ip/firewall/address-list": ["timeout"],
  "ip/dhcp-server/lease": [
    "status",
    "expires-after",
    "last-seen",
    "active-address",
    "active-mac-address",
    "active-client-id",
    "active-server",
    "host-name",
    "agent-circuit-id",
    "agent-remote-id",
    "radius",
    "blocked",
  ],
  "ip/dhcp-client": [
    "status",
    "address",
    "gateway",
    "dhcp-server",
    "primary-dns",
    "secondary-dns",
    "primary-ntp",
    "secondary-ntp",
    "expires-after",
  ],
  "interface/wireguard/peers": [
    "rx",
    "tx",
    "last-handshake",
    "current-endpoint-address",
    "current-endpoint-port",
    "responder",
  ],
  "ip/ipsec/policy": ["ph2-count", "ph2-state"],
  "interface/vrrp": ["master", "backup"],
  "queue/simple": [
    "rate",
    "packet-rate",
    "queued-bytes",
    "queued-packets",
    "dropped",
    "total-bytes",
    "total-packets",
    "total-queued-bytes",
    "total-queued-packets",
    "total-dropped",
    "total-rate",
    "total-packet-rate",
  ],
  "tool/netwatch": [
    "status",
    "since",
    "done-tests",
    "failed-tests",
    "loss-count",
    "loss-percent",
    "response-count",
    "rtt-avg",
    "rtt-min",
    "rtt-max",
    "rtt-jitter",
    "rtt-stdev",
    "http-status-code",
    "http-resp-time",
    "tcp-connect-time",
  ],
  // Execution bookkeeping: running a script or a job is not a configuration edit.
  "system/script": ["run-count", "last-started"],
  "system/scheduler": ["run-count", "next-run"],
  certificate: ["expires-after"],
  container: ["status"],
  // Log files and the like grow all the time; a name appearing or going is the drift that matters.
  file: ["size", "last-modified", "contents"],
};

/**
 * Records MikroMCP itself leaves behind while previewing: `upload_file`'s dry
 * run writes a `<name>.mikromcp-probe` over SFTP. Counting it would let
 * `plan_changes` invalidate the very planFingerprint it returns.
 */
const IGNORED_RECORDS_BY_PATH: Record<string, (record: RouterOSRecord) => boolean> = {
  file: (record) => String(record.name ?? "").endsWith(".mikromcp-probe"),
};

function stableRecord(
  record: RouterOSRecord,
  volatile: ReadonlySet<string>,
  dynamic: boolean,
): string {
  const entries: [string, RouterOSValue][] = Object.entries(record)
    .filter(([k]) => !RUNTIME_FIELDS.has(k) && !volatile.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // `dynamic` is a runtime field, but a kept dynamic record turning static (or
  // back) is exactly the drift its tool cares about.
  if (dynamic) entries.push(["~dynamic", true]);
  return JSON.stringify(entries);
}

/**
 * The part of one path's records a fingerprint covers, in the order the router
 * lists them. Dynamic records are router-generated and churn on their own, so
 * they are dropped, except the ones the call itself acts on (`keepDynamic`):
 * making a dynamic DHCP lease static approves that lease as previewed.
 */
export function fingerprintableRecords(
  path: string,
  records: RouterOSRecord[],
  keepDynamic?: DynamicTargets,
): string[] {
  const volatile = new Set(VOLATILE_FIELDS_BY_PATH[path] ?? []);
  const ignored = IGNORED_RECORDS_BY_PATH[path];
  const out: string[] = [];
  for (const record of records) {
    if (ignored?.(record)) continue;
    const dynamic = isTrue(record.dynamic);
    if (dynamic && !keepDynamic?.(path, record)) continue;
    out.push(stableRecord(record, volatile, dynamic));
  }
  return out;
}

/**
 * Hash the configuration under `paths` as the router reports it now: dynamic
 * records dropped (except those `keepDynamic` selects), runtime counters and status fields stripped, record order
 * kept (it matters on firewall chains, and `.id` stays in so a rule swapped for
 * an identical-looking one also counts). A confirmation token or a plan carries
 * this hash, so approving a preview approves the state that preview was made
 * against, not merely the same request.
 *
 * SwOS switches are not covered: their blobs mix configuration with live
 * readings (uptime, PoE power, link state), so they return NO_STATE_FINGERPRINT.
 * A read that fails throws: a state that cannot be read cannot be vouched for.
 */
export async function fingerprintState(
  client: DeviceClient,
  paths: string[],
  keepDynamic?: DynamicTargets,
): Promise<string> {
  const bound = [...new Set(paths)].filter((p) => !UNBOUND_PATHS.has(p));
  if (bound.length === 0 || client instanceof SwosClient) return NO_STATE_FINGERPRINT;

  const hash = createHash("sha256");
  for (const path of bound) {
    const records = await client.get<RouterOSRecord>(path, {});
    hash.update(JSON.stringify([path, fingerprintableRecords(path, records, keepDynamic)]));
  }
  return hash.digest("hex");
}

/** The state fingerprint for one call of `tool`: its state paths and the dynamic records it targets. */
export function fingerprintCall(
  client: DeviceClient,
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<string> {
  return fingerprintState(client, statePathsFor(tool, params), tool.stateDynamicTargets?.(params));
}

/** Combine several fingerprints (per router, per plan step) into one, order-sensitively. */
export function combineFingerprints(parts: readonly (readonly [string, string])[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

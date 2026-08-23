import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { RouterOSRecord, RouterOSValue, RestorePlan } from "../../types.js";
import { isTrue } from "../../adapter/response-parser.js";

/**
 * Volatile/read-only fields that RouterOS reports but that are not part of a
 * record's configuration. They must be dropped before diffing (otherwise every
 * snapshot looks "changed") and must never be written back on restore (RouterOS
 * rejects them). `.id` is intentionally NOT here — it is needed to address
 * records for update/remove.
 */
export const RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  "bytes",
  "packets",
  "dynamic",
  "invalid",
  "dead",
  "expired",
  "active",
  "running",
  "about",
  ".about",
  ".nextid",
  "creation-time",
  "last-logged-in",
  "last-link-up-time",
  "last-link-down-time",
  "link-downs",
  "rx-byte",
  "tx-byte",
  "rx-packet",
  "tx-packet",
  "uptime",
  // Read-only fields on set-menu singletons. Harmless in a normal diff, but a
  // singleton is restored by writing the whole record back through /set, and
  // RouterOS rejects the request outright if it carries a read-only parameter.
  "cache-used",
  "dynamic-servers",
]);

/** Paths where record ORDER is semantically significant and cannot be restored via create/update. */
export const ORDER_SENSITIVE_PATHS: ReadonlySet<string> = new Set([
  "ip/firewall/filter",
  "ip/firewall/nat",
  "ip/firewall/mangle",
  "routing/rule",
]);

/**
 * Drop dynamic (router-generated) records and strip runtime fields so the diff
 * compares only restorable configuration.
 */
export function normalizeForDiff(records: RouterOSRecord[]): RouterOSRecord[] {
  const out: RouterOSRecord[] = [];
  for (const r of records) {
    if (isTrue(r.dynamic)) continue;
    const clean: Record<string, RouterOSValue> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!RUNTIME_FIELDS.has(k)) clean[k] = v;
    }
    out.push(clean as RouterOSRecord);
  }
  return out;
}

export const SEMANTIC_KEYS: Record<string, readonly string[]> = {
  "ip/route": ["dst-address", "gateway", "routing-table"],
  "ip/firewall/filter": ["comment"],
  "ip/firewall/nat": ["comment"],
  "ip/firewall/mangle": ["comment"],
  "ip/firewall/address-list": ["list", "address"],
  "ip/address": ["address", "interface"],
  "ip/dns/static": ["name", "type"],
  "routing/rule": ["src-address", "routing-table"],
  "routing/table": ["name"],
  "interface/wireguard/peers": ["public-key"],
  "interface/bridge": ["name"],
  "interface/bridge/port": ["bridge", "interface"],
  "system/scheduler": ["name"],
  "system/script": ["name"],
  "system/package": ["name"],
  container: ["name"],
  certificate: ["name"],
  file: ["name"],
  "interface/vrrp": ["name"],
  "ip/dhcp-server": ["name"],
  "ip/ipsec/peer": ["name"],
  "ip/pool": ["name"],
  "queue/simple": ["name"],
  "tool/netwatch": ["host"],
  user: ["name"],
};

function normalizeValue(v: RouterOSValue | undefined): string {
  if (v === true || v === "true" || v === "yes") return "true";
  if (v === false || v === "false" || v === "no") return "false";
  return String(v ?? "");
}

function semanticKey(record: RouterOSRecord, keys: readonly string[]): string {
  return keys.map((k) => normalizeValue(record[k] ?? "")).join("|");
}

function recordSignature(record: RouterOSRecord): string {
  return Object.entries(record)
    .filter(([k]) => k !== ".id")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${normalizeValue(v)}`)
    .join(";");
}

function recordsAreEqual(a: RouterOSRecord, b: RouterOSRecord): boolean {
  const keysA = Object.keys(a).filter((k) => k !== ".id");
  const keysB = Object.keys(b).filter((k) => k !== ".id");
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => normalizeValue(a[k]) === normalizeValue(b[k] ?? ""));
}

function hasDuplicateKeys(records: RouterOSRecord[], keys: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const r of records) {
    const k = semanticKey(r, keys);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * Deleting users cannot be safely undone: passwords are not present in REST
 * reads, so recreating a removed user would produce a password-less login. Drop
 * such creations and warn instead.
 */
function applyUserRestriction(path: string, plan: RestorePlan): RestorePlan {
  if (path === "user" && plan.toCreate.length > 0) {
    plan.warnings.push(
      `Refusing to recreate ${plan.toCreate.length} deleted user(s): passwords are not stored in snapshots and recreation would produce password-less logins. Recreate manually with manage_user.`,
    );
    plan.toCreate = [];
  }
  return plan;
}

export function computeRestorePlan(
  path: string,
  beforeRaw: RouterOSRecord[],
  currentRaw: RouterOSRecord[],
): RestorePlan {
  const before = normalizeForDiff(beforeRaw);
  const current = normalizeForDiff(currentRaw);

  const warnings: string[] = [];
  if (ORDER_SENSITIVE_PATHS.has(path)) {
    warnings.push(
      `Restored entries for ${path} are re-created at the end of the list — rule ORDER is not restored. Review ordering manually after rollback.`,
    );
  }

  // A set-menu singleton (ip/dns, system/ntp/client, container/config) has no
  // `.id`, so it cannot be addressed for create/remove/update — the whole
  // record is written back through the /set command instead. Detected
  // structurally rather than from a path list so new singleton tools are
  // covered without touching this file.
  if (isSingleton(before, current)) {
    const beforeRecord = before[0];
    if (beforeRecord === undefined) {
      warnings.push(
        `Snapshot for ${path} holds no record for this singleton — its current settings are left untouched, as a set-menu singleton cannot be removed.`,
      );
      return { path, toCreate: [], toRemove: [], toUpdate: [], warnings };
    }

    const currentRecord = current[0];
    if (currentRecord !== undefined && recordsAreEqual(beforeRecord, currentRecord)) {
      return { path, toCreate: [], toRemove: [], toUpdate: [], warnings };
    }

    const { ".id": _id, ...data } = beforeRecord;
    const toSet = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>;
    return { path, toCreate: [], toRemove: [], toUpdate: [], toSet, warnings };
  }

  const keys = SEMANTIC_KEYS[path];
  // Fall back to full-record signature matching when a path has no semantic key
  // or when the chosen keys are not unique within a side (e.g. multiple
  // uncommented firewall rules collapsing to the same key), which would
  // otherwise drop all-but-one and schedule the rest for deletion.
  const canUseKeys =
    keys !== undefined && !hasDuplicateKeys(before, keys) && !hasDuplicateKeys(current, keys);

  if (!canUseKeys) {
    const beforeSigs = new Set(before.map(recordSignature));
    const currentSigs = new Set(current.map(recordSignature));
    return applyUserRestriction(path, {
      path,
      toCreate: before.filter((r) => !currentSigs.has(recordSignature(r))),
      toRemove: current.filter((r) => !beforeSigs.has(recordSignature(r))).map((r) => r[".id"]),
      toUpdate: [],
      warnings,
    });
  }

  const currentByKey = new Map(current.map((r) => [semanticKey(r, keys), r]));
  const beforeByKey = new Map(before.map((r) => [semanticKey(r, keys), r]));

  const toCreate: RouterOSRecord[] = [];
  const toUpdate: RestorePlan["toUpdate"] = [];

  for (const [key, beforeRecord] of beforeByKey) {
    const currentRecord = currentByKey.get(key);
    if (!currentRecord) {
      toCreate.push(beforeRecord);
    } else if (!recordsAreEqual(beforeRecord, currentRecord)) {
      const { ".id": _, ...data } = beforeRecord;
      toUpdate.push({ currentId: currentRecord[".id"], data: data as Record<string, string> });
    }
  }

  const toRemove = current
    .filter((r) => !beforeByKey.has(semanticKey(r, keys)))
    .map((r) => r[".id"]);

  return applyUserRestriction(path, { path, toCreate, toRemove, toUpdate, warnings });
}

/**
 * True when both sides describe a set-menu singleton: at most one record per
 * side, none of them carrying an `.id`, and at least one record present.
 */
function isSingleton(before: RouterOSRecord[], current: RouterOSRecord[]): boolean {
  if (before.length > 1 || current.length > 1) return false;
  if (before.length === 0 && current.length === 0) return false;
  return [...before, ...current].every((r) => r[".id"] === undefined);
}

export async function applyRestorePlan(
  plan: RestorePlan,
  client: RouterOSRestClient,
): Promise<void> {
  if (plan.toSet !== undefined) {
    await client.execute(`${plan.path}/set`, plan.toSet);
    return;
  }
  for (const id of plan.toRemove) {
    await client.remove(plan.path, id);
  }
  for (const record of plan.toCreate) {
    const { ".id": _, ...data } = record;
    await client.create(plan.path, data as Record<string, string>);
  }
  for (const { currentId, data } of plan.toUpdate) {
    await client.update(plan.path, currentId, data);
  }
}

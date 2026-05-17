import type { RouterOSRestClient } from "../../adapter/rest-client.js";
import type { RouterOSRecord, RestorePlan } from "../../types.js";

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
  "container": ["name"],
};

function normalizeValue(v: string): string {
  if (v === "true" || v === "yes") return "true";
  if (v === "false" || v === "no") return "false";
  return v;
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

export function computeRestorePlan(
  path: string,
  before: RouterOSRecord[],
  current: RouterOSRecord[],
): RestorePlan {
  const keys = SEMANTIC_KEYS[path];

  if (!keys) {
    const beforeSigs = new Set(before.map(recordSignature));
    const currentSigs = new Set(current.map(recordSignature));
    return {
      path,
      toCreate: before.filter((r) => !currentSigs.has(recordSignature(r))),
      toRemove: current.filter((r) => !beforeSigs.has(recordSignature(r))).map((r) => r[".id"]),
      toUpdate: [],
    };
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

  return { path, toCreate, toRemove, toUpdate };
}

export async function applyRestorePlan(
  plan: RestorePlan,
  client: RouterOSRestClient,
): Promise<void> {
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

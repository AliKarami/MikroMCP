import { describe, it, expect, vi } from "vitest";
import {
  fingerprintState,
  combineFingerprints,
  NO_STATE_FINGERPRINT,
} from "../../../../src/domain/snapshot/state-fingerprint.js";
import { SwosClient } from "../../../../src/adapter/swos-client.js";
import type { DeviceClient } from "../../../../src/adapter/connection-pool.js";
import { fromWire, type WireRecord } from "../../helpers/wire.js";

function clientWith(byPath: Record<string, WireRecord[]>): DeviceClient {
  return {
    get: vi.fn(async (path: string) => fromWire(byPath[path] ?? [])),
  } as unknown as DeviceClient;
}

const RULE: WireRecord = {
  ".id": "*A",
  chain: "forward",
  action: "drop",
  "src-address": "10.0.0.0/8",
  comment: "block-lab",
  disabled: "false",
  bytes: "1000",
  packets: "10",
};

const OTHER: WireRecord = {
  ".id": "*B",
  chain: "input",
  action: "accept",
  comment: "allow-ssh",
  disabled: "false",
};

describe("fingerprintState", () => {
  it("is stable across two reads of an unchanged section", async () => {
    const client = clientWith({ "ip/firewall/filter": [RULE, OTHER] });
    const a = await fingerprintState(client, ["ip/firewall/filter"]);
    const b = await fingerprintState(client, ["ip/firewall/filter"]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("ignores traffic counters, which change without anyone touching the router", async () => {
    const before = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE] }), [
      "ip/firewall/filter",
    ]);
    const after = await fingerprintState(
      clientWith({ "ip/firewall/filter": [{ ...RULE, bytes: "999999", packets: "4242" }] }),
      ["ip/firewall/filter"],
    );
    expect(after).toBe(before);
  });

  it("changes when a rule's match changes", async () => {
    const before = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE] }), [
      "ip/firewall/filter",
    ]);
    const after = await fingerprintState(
      clientWith({ "ip/firewall/filter": [{ ...RULE, "src-address": "0.0.0.0/0" }] }),
      ["ip/firewall/filter"],
    );
    expect(after).not.toBe(before);
  });

  it("changes when a rule is disabled", async () => {
    const before = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE] }), [
      "ip/firewall/filter",
    ]);
    const after = await fingerprintState(
      clientWith({ "ip/firewall/filter": [{ ...RULE, disabled: "true" }] }),
      ["ip/firewall/filter"],
    );
    expect(after).not.toBe(before);
  });

  it("changes when rules are reordered (placement is configuration on a chain)", async () => {
    const before = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE, OTHER] }), [
      "ip/firewall/filter",
    ]);
    const after = await fingerprintState(clientWith({ "ip/firewall/filter": [OTHER, RULE] }), [
      "ip/firewall/filter",
    ]);
    expect(after).not.toBe(before);
  });

  it("does not depend on the order fields arrive in", async () => {
    const reversed = Object.fromEntries(Object.entries(RULE).reverse());
    const a = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE] }), [
      "ip/firewall/filter",
    ]);
    const b = await fingerprintState(clientWith({ "ip/firewall/filter": [reversed] }), [
      "ip/firewall/filter",
    ]);
    expect(b).toBe(a);
  });

  it("ignores dynamic records", async () => {
    const dynamic: WireRecord = {
      ".id": "*D",
      chain: "forward",
      action: "fasttrack-connection",
      dynamic: "true",
    };
    const a = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE] }), [
      "ip/firewall/filter",
    ]);
    const b = await fingerprintState(clientWith({ "ip/firewall/filter": [RULE, dynamic] }), [
      "ip/firewall/filter",
    ]);
    expect(b).toBe(a);
  });

  it("ignores per-path status fields (a DHCP lease's expires-after counts down)", async () => {
    const lease: WireRecord = {
      ".id": "*1",
      address: "192.168.88.10",
      "mac-address": "AA:BB:CC:DD:EE:FF",
      status: "bound",
      "expires-after": "9m59s",
    };
    const a = await fingerprintState(clientWith({ "ip/dhcp-server/lease": [lease] }), [
      "ip/dhcp-server/lease",
    ]);
    const b = await fingerprintState(
      clientWith({
        "ip/dhcp-server/lease": [{ ...lease, status: "waiting", "expires-after": "1s" }],
      }),
      ["ip/dhcp-server/lease"],
    );
    expect(b).toBe(a);
  });

  it("keeps a field that is volatile only on another path", async () => {
    const addr: WireRecord = { ".id": "*1", address: "10.0.0.1/24", interface: "ether1" };
    const a = await fingerprintState(clientWith({ "ip/address": [addr] }), ["ip/address"]);
    const b = await fingerprintState(
      clientWith({ "ip/address": [{ ...addr, address: "10.0.0.2/24" }] }),
      ["ip/address"],
    );
    expect(b).not.toBe(a);
  });

  it("binds nothing for a call with no state paths, or only the clock", async () => {
    const client = clientWith({});
    expect(await fingerprintState(client, [])).toBe(NO_STATE_FINGERPRINT);
    expect(await fingerprintState(client, ["system/clock"])).toBe(NO_STATE_FINGERPRINT);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("binds nothing on a SwOS switch, whose blobs carry live readings", async () => {
    const swos = Object.create(SwosClient.prototype) as DeviceClient;
    expect(await fingerprintState(swos, ["sys.b"])).toBe(NO_STATE_FINGERPRINT);
  });

  it("throws when the state cannot be read", async () => {
    const client = {
      get: vi.fn().mockRejectedValue(new Error("unreachable")),
    } as unknown as DeviceClient;
    await expect(fingerprintState(client, ["ip/route"])).rejects.toThrow("unreachable");
  });
});

describe("dynamic records a call targets", () => {
  const LEASE_PATH = "ip/dhcp-server/lease";
  const lease: WireRecord = {
    ".id": "*5",
    address: "192.168.88.50",
    "mac-address": "AA:BB:CC:00:00:01",
    server: "lan",
    dynamic: "true",
    status: "bound",
    "expires-after": "8m",
  };
  const byMac = (path: string, record: Record<string, unknown>) =>
    path === LEASE_PATH && record["mac-address"] === "AA:BB:CC:00:00:01";

  it("binds a targeted dynamic lease, so a new address after the preview counts as drift", async () => {
    const a = await fingerprintState(clientWith({ [LEASE_PATH]: [lease] }), [LEASE_PATH], byMac);
    const b = await fingerprintState(
      clientWith({ [LEASE_PATH]: [{ ...lease, address: "192.168.88.99" }] }),
      [LEASE_PATH],
      byMac,
    );
    expect(b).not.toBe(a);
  });

  it("binds the lease's identity: a replaced lease for the same MAC counts as drift", async () => {
    const a = await fingerprintState(clientWith({ [LEASE_PATH]: [lease] }), [LEASE_PATH], byMac);
    const b = await fingerprintState(
      clientWith({ [LEASE_PATH]: [{ ...lease, ".id": "*6" }] }),
      [LEASE_PATH],
      byMac,
    );
    expect(b).not.toBe(a);
  });

  it("counts the lease turning static as drift", async () => {
    const a = await fingerprintState(clientWith({ [LEASE_PATH]: [lease] }), [LEASE_PATH], byMac);
    const b = await fingerprintState(
      clientWith({ [LEASE_PATH]: [{ ...lease, dynamic: "false" }] }),
      [LEASE_PATH],
      byMac,
    );
    expect(b).not.toBe(a);
  });

  it("still ignores the targeted lease's status fields and other dynamic leases", async () => {
    const other: WireRecord = { ...lease, ".id": "*9", "mac-address": "AA:BB:CC:00:00:02" };
    const a = await fingerprintState(clientWith({ [LEASE_PATH]: [lease] }), [LEASE_PATH], byMac);
    const b = await fingerprintState(
      clientWith({
        [LEASE_PATH]: [{ ...lease, status: "waiting", "expires-after": "1s" }, other],
      }),
      [LEASE_PATH],
      byMac,
    );
    expect(b).toBe(a);
  });
});

describe("combineFingerprints", () => {
  it("is order-sensitive and key-sensitive", () => {
    const ab = combineFingerprints([
      ["r1", "a"],
      ["r2", "b"],
    ]);
    expect(
      combineFingerprints([
        ["r1", "a"],
        ["r2", "b"],
      ]),
    ).toBe(ab);
    expect(
      combineFingerprints([
        ["r1", "b"],
        ["r2", "a"],
      ]),
    ).not.toBe(ab);
  });
});

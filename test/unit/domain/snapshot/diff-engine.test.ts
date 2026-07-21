import { describe, it, expect, vi } from "vitest";
import { computeRestorePlan, applyRestorePlan } from "../../../../src/domain/snapshot/diff-engine.js";
import type { RouterOSRestClient } from "../../../../src/adapter/rest-client.js";
import type { RouterOSRecord } from "../../../../src/types.js";

const ROUTE_A: RouterOSRecord = { ".id": "*1", "dst-address": "10.0.0.0/8", "gateway": "192.168.1.1", "routing-table": "main", "distance": "1" };
const ROUTE_B: RouterOSRecord = { ".id": "*2", "dst-address": "172.16.0.0/12", "gateway": "192.168.1.1", "routing-table": "main", "distance": "1" };

describe("computeRestorePlan", () => {
  it("identifies records to create (in before, not in current)", () => {
    const plan = computeRestorePlan("ip/route", [ROUTE_A], []);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]["dst-address"]).toBe("10.0.0.0/8");
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it("identifies records to remove (in current, not in before)", () => {
    const plan = computeRestorePlan("ip/route", [], [ROUTE_B]);
    expect(plan.toRemove).toEqual(["*2"]);
    expect(plan.toCreate).toHaveLength(0);
  });

  it("identifies records to update (same key, different values)", () => {
    const changed: RouterOSRecord = { ...ROUTE_A, "distance": "10" };
    const plan = computeRestorePlan("ip/route", [ROUTE_A], [changed]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toUpdate[0].currentId).toBe("*1");
    expect(plan.toUpdate[0].data["distance"]).toBe("1");
  });

  it("no-op when before and current are identical", () => {
    const plan = computeRestorePlan("ip/route", [ROUTE_A], [ROUTE_A]);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it("falls back to full-record key for unknown paths", () => {
    const rec: RouterOSRecord = { ".id": "*1", "name": "foo", "value": "bar" };
    const plan = computeRestorePlan("some/unknown/path", [rec], []);
    expect(plan.toCreate).toHaveLength(1);
  });

  it("treats a changed property on a keyed certificate as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "my-ca", "trusted": "yes" };
    const current: RouterOSRecord = { ".id": "*9", "name": "my-ca", "trusted": "no" };
    const plan = computeRestorePlan("certificate", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed file as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "flash/script.rsc", "size": "100" };
    const current: RouterOSRecord = { ".id": "*9", "name": "flash/script.rsc", "size": "200" };
    const plan = computeRestorePlan("file", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed interface/vrrp as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "vrrp1", "priority": "100" };
    const current: RouterOSRecord = { ".id": "*9", "name": "vrrp1", "priority": "150" };
    const plan = computeRestorePlan("interface/vrrp", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed ip/dhcp-server as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "dhcp1", "disabled": "false" };
    const current: RouterOSRecord = { ".id": "*9", "name": "dhcp1", "disabled": "true" };
    const plan = computeRestorePlan("ip/dhcp-server", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed ip/ipsec/peer as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "peer1", "address": "10.0.0.1" };
    const current: RouterOSRecord = { ".id": "*9", "name": "peer1", "address": "10.0.0.2" };
    const plan = computeRestorePlan("ip/ipsec/peer", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed ip/pool as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "dhcp-pool", "ranges": "192.168.1.10-192.168.1.100" };
    const current: RouterOSRecord = { ".id": "*9", "name": "dhcp-pool", "ranges": "192.168.1.10-192.168.1.200" };
    const plan = computeRestorePlan("ip/pool", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed queue/simple as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "client-limit", "max-limit": "10M/10M" };
    const current: RouterOSRecord = { ".id": "*9", "name": "client-limit", "max-limit": "20M/20M" };
    const plan = computeRestorePlan("queue/simple", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed tool/netwatch as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "host": "8.8.8.8", "interval": "00:01:00" };
    const current: RouterOSRecord = { ".id": "*9", "host": "8.8.8.8", "interval": "00:05:00" };
    const plan = computeRestorePlan("tool/netwatch", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("treats a changed property on a keyed user as an update, not delete+create", () => {
    const before: RouterOSRecord = { ".id": "*1", "name": "admin2", "group": "write" };
    const current: RouterOSRecord = { ".id": "*9", "name": "admin2", "group": "read" };
    const plan = computeRestorePlan("user", [before], [current]);
    expect(plan.toUpdate).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  describe("hardening", () => {
    it("ignores records that differ only in runtime fields (bytes/packets)", () => {
      const before: RouterOSRecord = { ".id": "*1", comment: "web", action: "accept", bytes: "10", packets: "1" };
      const current: RouterOSRecord = { ".id": "*1", comment: "web", action: "accept", bytes: "9999", packets: "42" };
      const plan = computeRestorePlan("ip/firewall/filter", [before], [current]);
      expect(plan.toCreate).toHaveLength(0);
      expect(plan.toRemove).toHaveLength(0);
      expect(plan.toUpdate).toHaveLength(0);
    });

    it("ignores dynamic records on both sides", () => {
      const before: RouterOSRecord = { ".id": "*1", "dst-address": "10.0.0.0/8", gateway: "1.1.1.1", "routing-table": "main", dynamic: true };
      const current: RouterOSRecord = { ".id": "*2", "dst-address": "10.0.0.0/8", gateway: "1.1.1.1", "routing-table": "main", dynamic: true };
      const plan = computeRestorePlan("ip/route", [before], [current]);
      expect(plan.toCreate).toHaveLength(0);
      expect(plan.toRemove).toHaveLength(0);
      expect(plan.toUpdate).toHaveLength(0);
    });

    it("does not drop uncommented firewall rules that collide on the semantic key", () => {
      // Two uncommented rules → both semantic key "" → must fall back to
      // signature diff instead of Map-collapsing to one.
      const ruleA: RouterOSRecord = { ".id": "*1", chain: "input", action: "accept", protocol: "tcp" };
      const ruleB: RouterOSRecord = { ".id": "*2", chain: "input", action: "drop", protocol: "udp" };
      const plan = computeRestorePlan("ip/firewall/filter", [ruleA, ruleB], [ruleA, ruleB]);
      expect(plan.toRemove).toHaveLength(0);
      expect(plan.toCreate).toHaveLength(0);
    });

    it("warns that order is not restored for order-sensitive paths", () => {
      const plan = computeRestorePlan("ip/firewall/filter", [], []);
      expect(plan.warnings.join(" ")).toMatch(/order/i);
    });

    it("never recreates deleted users; warns instead", () => {
      const before: RouterOSRecord = { ".id": "*1", name: "admin2", group: "full" };
      const plan = computeRestorePlan("user", [before], []);
      expect(plan.toCreate).toHaveLength(0);
      expect(plan.warnings.join(" ")).toMatch(/password/i);
    });
  });
});

describe("applyRestorePlan", () => {
  it("calls create for toCreate records (strips .id)", async () => {
    const client = { create: vi.fn().mockResolvedValue({ ".id": "*99" }), remove: vi.fn(), update: vi.fn() } as unknown as RouterOSRestClient;
    const plan = { path: "ip/route", toCreate: [ROUTE_A], toRemove: [], toUpdate: [], warnings: [] };
    await applyRestorePlan(plan, client);
    expect(client.create).toHaveBeenCalledWith("ip/route", {
      "dst-address": "10.0.0.0/8",
      "gateway": "192.168.1.1",
      "routing-table": "main",
      "distance": "1",
    });
  });

  it("calls remove for toRemove ids", async () => {
    const client = { create: vi.fn(), remove: vi.fn().mockResolvedValue(undefined), update: vi.fn() } as unknown as RouterOSRestClient;
    const plan = { path: "ip/route", toCreate: [], toRemove: ["*2"], toUpdate: [], warnings: [] };
    await applyRestorePlan(plan, client);
    expect(client.remove).toHaveBeenCalledWith("ip/route", "*2");
  });

  it("calls update for toUpdate entries", async () => {
    const client = { create: vi.fn(), remove: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } as unknown as RouterOSRestClient;
    const plan = { path: "ip/route", toCreate: [], toRemove: [], toUpdate: [{ currentId: "*1", data: { "distance": "1" } }], warnings: [] };
    await applyRestorePlan(plan, client);
    expect(client.update).toHaveBeenCalledWith("ip/route", "*1", { "distance": "1" });
  });
});

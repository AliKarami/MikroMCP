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
});

describe("applyRestorePlan", () => {
  it("calls create for toCreate records (strips .id)", async () => {
    const client = { create: vi.fn().mockResolvedValue({ ".id": "*99" }), remove: vi.fn(), update: vi.fn() } as unknown as RouterOSRestClient;
    const plan = { path: "ip/route", toCreate: [ROUTE_A], toRemove: [], toUpdate: [] };
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
    const plan = { path: "ip/route", toCreate: [], toRemove: ["*2"], toUpdate: [] };
    await applyRestorePlan(plan, client);
    expect(client.remove).toHaveBeenCalledWith("ip/route", "*2");
  });

  it("calls update for toUpdate entries", async () => {
    const client = { create: vi.fn(), remove: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } as unknown as RouterOSRestClient;
    const plan = { path: "ip/route", toCreate: [], toRemove: [], toUpdate: [{ currentId: "*1", data: { "distance": "1" } }] };
    await applyRestorePlan(plan, client);
    expect(client.update).toHaveBeenCalledWith("ip/route", "*1", { "distance": "1" });
  });
});

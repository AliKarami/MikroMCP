import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swosApplyTiming, swosConfigTools } from "../../../src/domain/tools/swos-config-tools.js";
import {
  snapshotPathsFor,
  type ToolContext,
  loggableParams,
} from "../../../src/domain/tools/tool-definition.js";
import type { SwosClient } from "../../../src/adapter/swos-client.js";
import { decodeEndpoint, dumpBlob, parseWireBlob } from "../../../src/adapter/swos-protocol.js";
import { WITHHELD_CONFIG_TEXT } from "../../../src/domain/swos/switch-config.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const FULL = join(import.meta.dirname, "../../fixtures/swos-full");
const [getTool, applyTool] = swosConfigTools;

swosApplyTiming.confirmDelayMs = 0;

/**
 * A switch backed by the full-SwOS fixtures; POSTs replace the stored blob. The POST to `failOn`
 * times out; with `appliesAnyway` the switch still stores it (the answer is lost, the write is not).
 */
function makeSwitch(failOn?: string, appliesAnyway = false) {
  const store = new Map<string, string>();
  const posts: string[] = [];
  const load = (ep: string) => store.get(ep) ?? readFileSync(join(FULL, ep), "utf8").trim();
  const client = {
    getRaw: vi.fn(async (ep: string) => load(ep)),
    readBlob: vi.fn(async (ep: string) => parseWireBlob(load(ep))),
    readBlobForWrite: vi.fn(async (ep: string) => {
      const raw = load(ep);
      const wire = parseWireBlob(raw);
      expect(dumpBlob(wire)).toBe(raw);
      return wire;
    }),
    postRaw: vi.fn(async (ep: string, body: string) => {
      if (ep === failOn) {
        if (appliesAnyway) store.set(ep, body);
        throw new MikroMCPError({
          category: ErrorCategory.ROUTER_TIMEOUT,
          code: "SWOS_REQUEST_TIMEOUT",
          message: `SwOS POST request to /${ep} timed out`,
          recoverability: { retryable: false, suggestedAction: "" },
        });
      }
      posts.push(ep);
      store.set(ep, body);
      return "";
    }),
  };
  return { client, posts, store };
}

function makeContext(sw?: ReturnType<typeof makeSwitch>, secrets: Record<string, string> = {}) {
  return {
    routerId: "switch-01",
    correlationId: "test-corr",
    swosClient: sw?.client as unknown as SwosClient | undefined,
    deviceClient: sw?.client,
    appConfig: { configSecrets: secrets },
  } as unknown as ToolContext;
}

const OFFICE = {
  version: 1,
  system: { identity: "office-sw", independent_vlan_lookup: true, igmp_snooping: true },
  ports: {
    "1": { name: "desk-1", vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 200 },
    "8": { name: "service", vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 },
    "17": { name: "uplink", vlan_mode: "strict", vlan_receive: "only_tagged", default_vlan: 1 },
  },
  vlans: [
    { id: 100, name: "MGMT", members: [8, 17] },
    { id: 200, name: "STAFF", members: [1, 17] },
  ],
  snmp: { enabled: true, community: "${SNMP_COMMUNITY}" },
};
const SECRETS = { SNMP_COMMUNITY: "c0mmunity" };

describe("swosConfigTools", () => {
  describe("metadata", () => {
    it("exports get_swos_config and apply_swos_config for the swos platform", () => {
      expect(swosConfigTools.map((t) => t.name)).toEqual(["get_swos_config", "apply_swos_config"]);
      for (const tool of swosConfigTools) expect(tool.platform).toBe("swos");
      expect(getTool.annotations.readOnlyHint).toBe(true);
      expect(applyTool.annotations.readOnlyHint).toBe(false);
      expect(applyTool.annotations.destructiveHint).toBe(true);
    });

    it("snapshots all six endpoints for a real apply and none for a preview", () => {
      expect(snapshotPathsFor(applyTool, { dryRun: false })).toEqual([
        "vlan.b",
        "fwd.b",
        "link.b",
        "lacp.b",
        "snmp.b",
        "sys.b",
      ]);
      expect(snapshotPathsFor(applyTool, {})).toEqual([]);
    });

    it("rejects extra parameters", async () => {
      await expect(
        applyTool.handler(
          { routerId: "switch-01", config: {}, extra: 1 },
          makeContext(makeSwitch()),
        ),
      ).rejects.toThrow();
    });
  });

  describe("input schemas", () => {
    it("fills the defaults of apply_swos_config and rejects unknown fields", () => {
      const parsed = applyTool.inputSchema.parse({ routerId: "switch-01", config: { version: 1 } });
      expect(parsed).toMatchObject({ dryRun: true, includeManagement: false, pruneVlans: true });
      expect(() =>
        applyTool.inputSchema.parse({ routerId: "switch-01", config: { version: 1 }, force: true }),
      ).toThrow();
      expect(() => getTool.inputSchema.parse({ routerId: "switch-01", extra: 1 })).toThrow();
    });
  });

  describe("get_swos_config", () => {
    it("exports every port, the VLAN table and SNMP without the community", async () => {
      const result = await getTool.handler({ routerId: "switch-01" }, makeContext(makeSwitch()));
      const doc = (result.structuredContent as { config: Record<string, unknown> }).config;
      expect(doc.version).toBe(1);
      expect(Object.keys(doc.ports as object)).toHaveLength(18);
      expect((doc.ports as Record<string, unknown>)["17"]).toEqual({
        name: "SFP+1",
        enabled: true,
        vlan_mode: "optional",
        vlan_receive: "any",
        default_vlan: 1,
        force_vlan: false,
        forward_to: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18],
        limit_unknown_unicast: false,
        flood_unknown_multicast: true,
        storm_rate: 100,
        lag_mode: "passive",
        lag_group: 0,
        auto_negotiation: true,
      });
      expect(doc.vlans).toEqual([]);
      expect(doc.snmp).toEqual({ enabled: true, contact: "", location: "" });
      expect(result.content).not.toContain("public");
      expect(result.content).toContain("version: 1");
    });

    it("throws PLATFORM_MISMATCH for a RouterOS device", async () => {
      await expect(getTool.handler({ routerId: "switch-01" }, makeContext())).rejects.toMatchObject(
        {
          code: "PLATFORM_MISMATCH",
        },
      );
    });
  });

  describe("apply_swos_config", () => {
    it("defaults to a dry run that writes nothing", async () => {
      const sw = makeSwitch();
      const result = await applyTool.handler(
        { routerId: "switch-01", config: OFFICE },
        makeContext(sw, SECRETS),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(sw.client.postRaw).not.toHaveBeenCalled();
      expect(result.content).toContain("DRY RUN");
      expect(result.content).toContain("add VLAN 100");
      expect(result.content).not.toContain("c0mmunity");
    });

    it("writes the changed endpoints in order and is idempotent afterwards", async () => {
      const sw = makeSwitch();
      // OFFICE turns the linked uplink tagged-only, which the lockout check gates.
      const params = {
        routerId: "switch-01",
        config: OFFICE,
        dryRun: false,
        includeManagement: true,
        acceptLockoutRisk: true,
      };
      const result = await applyTool.handler(params, makeContext(sw, SECRETS));
      expect((result.structuredContent as Record<string, unknown>).action).toBe("applied");
      expect(sw.posts).toEqual(["vlan.b", "fwd.b", "link.b", "snmp.b", "sys.b"]);
      const snmp = decodeEndpoint("snmp.b", sw.store.get("snmp.b") ?? "") as Record<
        string,
        unknown
      >;
      expect(snmp.community).toBe("c0mmunity");

      const again = await applyTool.handler(params, makeContext(sw, SECRETS));
      expect((again.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(sw.posts).toHaveLength(5);
    });

    it("reports whether the write was snapshotted, and says so when it was not", async () => {
      const params = {
        routerId: "switch-01",
        config: OFFICE,
        dryRun: false,
        includeManagement: true,
        acceptLockoutRisk: true,
      };
      const six = ["vlan.b", "fwd.b", "link.b", "lacp.b", "snmp.b", "sys.b"];
      const all = await applyTool.handler(params, {
        ...makeContext(makeSwitch(), SECRETS),
        snapshots: { taken: six, failed: [] },
      } as ToolContext);
      expect(all.content).toContain("all six endpoints was snapshotted");
      expect((all.structuredContent as Record<string, unknown>).snapshotted).toBe("all");

      const partial = await applyTool.handler(params, {
        ...makeContext(makeSwitch(), SECRETS),
        snapshots: { taken: six.filter((ep) => ep !== "snmp.b"), failed: ["snmp.b"] },
      } as ToolContext);
      expect(partial.content).toContain("but not snmp.b");
      expect((partial.structuredContent as Record<string, unknown>).snapshotted).toBe("partial");

      // A context that records no snapshot is "none", not "all six".
      for (const snapshots of [undefined, { taken: [], failed: [] }]) {
        const none = await applyTool.handler(params, {
          ...makeContext(makeSwitch(), SECRETS),
          snapshots,
        } as ToolContext);
        expect(none.content).toContain("No snapshot was recorded for this write");
        expect(none.content).not.toContain("all six");
        expect((none.structuredContent as Record<string, unknown>).snapshotted).toBe("none");
      }
      const failed = await applyTool.handler(params, {
        ...makeContext(makeSwitch(), SECRETS),
        snapshots: { taken: [], failed: six },
      } as ToolContext);
      expect(failed.content).toContain("No endpoint could be snapshotted");
    });

    it("accepts the config as YAML text", async () => {
      const sw = makeSwitch();
      const yaml = "version: 1\nvlans:\n  - { id: 30, name: IOT, members: [13, 14, 17] }\n";
      await applyTool.handler(
        {
          routerId: "switch-01",
          config: yaml,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw),
      );
      expect(sw.posts).toEqual(["vlan.b"]);
    });

    it("round-trips: applying the exported document changes nothing", async () => {
      const sw = makeSwitch();
      await applyTool.handler(
        {
          routerId: "switch-01",
          config: OFFICE,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw, SECRETS),
      );
      const exported = await getTool.handler({ routerId: "switch-01" }, makeContext(sw));
      const { yaml } = exported.structuredContent as { yaml: string };
      const back = await applyTool.handler(
        {
          routerId: "switch-01",
          config: yaml,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw),
      );
      expect((back.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });

    it("refuses a text config that spells out the SNMP community", async () => {
      const sw = makeSwitch();
      const text = "version: 1\nsnmp:\n  community: plaintext-community\n";
      await expect(
        applyTool.handler({ routerId: "switch-01", config: text, dryRun: true }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_CONFIG_SECRET_REQUIRED" });
      // As an object the key is redacted by the audit log, so a literal is allowed.
      const result = await applyTool.handler(
        {
          routerId: "switch-01",
          config: { version: 1, snmp: { community: "plaintext-community" } },
          dryRun: true,
        },
        makeContext(sw),
      );
      expect(result.content).not.toContain("plaintext-community");
    });

    it("scrubs a written-out community from what the executor logs", () => {
      const text = "version: 1\nsnmp:\n  community: s3cr3t\n";
      expect(loggableParams(applyTool, { routerId: "switch-01", config: text })).toEqual({
        routerId: "switch-01",
        config: WITHHELD_CONFIG_TEXT,
      });
      expect(
        loggableParams(applyTool, { routerId: "switch-01", config: { snmp: { community: "x" } } }),
      ).toEqual({ routerId: "switch-01", config: { snmp: { community: "<redacted>" } } });
      // Tools without a redactor log their parameters as they are.
      expect(loggableParams(getTool, { routerId: "switch-01" })).toEqual({ routerId: "switch-01" });
    });

    it("gates a linked port that would accept tagged frames only", async () => {
      const sw = makeSwitch();
      const config = { version: 1, ports: { "17": { vlan_receive: "only_tagged" } } };
      await expect(
        applyTool.handler({ routerId: "switch-01", config, dryRun: false }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_LOCKOUT_RISK" });
      const dry = await applyTool.handler(
        { routerId: "switch-01", config, dryRun: true },
        makeContext(sw),
      );
      expect((dry.structuredContent as { warnings: string[] }).warnings[0]).toMatch(
        /Port 17 has a link and would accept tagged frames only/,
      );
    });

    it("keeps VLANs the config does not list when pruneVlans is false", async () => {
      const sw = makeSwitch();
      sw.store.set(
        "vlan.b",
        "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}," +
          "{vid:0x0063,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000000}]",
      );
      const config = { version: 1, vlans: [{ id: 200, members: [8] }] };
      const settings = (r: { structuredContent: unknown }) =>
        (
          r.structuredContent as { endpoints: { changes: { setting: string }[] }[] }
        ).endpoints.flatMap((e) => e.changes.map((c) => c.setting));
      const kept = await applyTool.handler(
        { routerId: "switch-01", config, dryRun: true, pruneVlans: false },
        makeContext(sw),
      );
      expect(settings(kept)).toEqual(["add"]);
      const pruned = await applyTool.handler(
        { routerId: "switch-01", config, dryRun: true },
        makeContext(sw),
      );
      expect(settings(pruned).filter((c) => c === "remove")).toHaveLength(2);
    });

    it("refuses management changes unless includeManagement is set", async () => {
      const sw = makeSwitch();
      const config = { version: 1, system: { static_ip: "192.168.88.2", allow_from_vlan: 100 } };
      await expect(
        applyTool.handler({ routerId: "switch-01", config, dryRun: false }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_MANAGEMENT_CHANGE_REFUSED" });
      expect(sw.client.postRaw).not.toHaveBeenCalled();

      await applyTool.handler(
        {
          routerId: "switch-01",
          config,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw),
      );
      expect(sw.posts).toEqual(["sys.b"]);
    });

    it("names a missing secret before reading the switch", async () => {
      const sw = makeSwitch();
      await expect(
        applyTool.handler({ routerId: "switch-01", config: OFFICE }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_CONFIG_SECRET_MISSING" });
      expect(sw.client.readBlobForWrite).not.toHaveBeenCalled();
      expect(sw.client.readBlob).not.toHaveBeenCalled();
    });

    it("reports which endpoints were written when a later write fails", async () => {
      const sw = makeSwitch("link.b");
      await expect(
        applyTool.handler(
          {
            routerId: "switch-01",
            config: OFFICE,
            dryRun: false,
            includeManagement: true,
            acceptLockoutRisk: true,
          },
          makeContext(sw, SECRETS),
        ),
      ).rejects.toMatchObject({
        code: "SWOS_APPLY_INCOMPLETE",
        details: { written: ["vlan.b (grow)", "fwd.b"], failedAt: "link.b" },
      });
    });

    it("confirms an unanswered per-port write by reading back, and carries on", async () => {
      const sw = makeSwitch("fwd.b", true);
      const res = await applyTool.handler(
        {
          routerId: "switch-01",
          config: OFFICE,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw, SECRETS),
      );
      const out = res.structuredContent as { action: string; written: string[] };
      expect(out.action).toBe("applied");
      expect(out.written).toContain("fwd.b (confirmed by read-back)");
      expect(sw.posts).toContain("link.b");
      expect(sw.posts).toContain("sys.b");
    });

    it("still stops on an unanswered write the read-back does not confirm", async () => {
      const sw = makeSwitch("fwd.b");
      await expect(
        applyTool.handler(
          {
            routerId: "switch-01",
            config: OFFICE,
            dryRun: false,
            includeManagement: true,
            acceptLockoutRisk: true,
          },
          makeContext(sw, SECRETS),
        ),
      ).rejects.toMatchObject({
        code: "SWOS_APPLY_INCOMPLETE",
        details: { written: ["vlan.b (grow)"], failedAt: "fwd.b", possiblyWritten: "fwd.b" },
      });
      expect(sw.posts).not.toContain("link.b");
    });

    it("keeps an unanswered VLAN-table grow ambiguous even when the switch took it", async () => {
      const sw = makeSwitch("vlan.b", true);
      await expect(
        applyTool.handler(
          {
            routerId: "switch-01",
            config: OFFICE,
            dryRun: false,
            includeManagement: true,
            acceptLockoutRisk: true,
          },
          makeContext(sw, SECRETS),
        ),
      ).rejects.toMatchObject({
        code: "SWOS_APPLY_INCOMPLETE",
        details: { failedAt: "vlan.b (grow)" },
      });
      expect(sw.posts).toEqual([]);
    });

    it("surfaces the lockout warning in a preview", async () => {
      const sw = makeSwitch();
      const config = {
        version: 1,
        ports: { "1": { vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 } },
        vlans: [{ id: 100, members: [17] }],
      };
      const result = await applyTool.handler({ routerId: "switch-01", config }, makeContext(sw));
      expect((result.structuredContent as { warnings: string[] }).warnings).toHaveLength(2);
      expect(result.content).toContain("Port 1 is strict with default VLAN 100");
    });

    it("refuses a real apply that would cut a port off unless acceptLockoutRisk is set", async () => {
      const sw = makeSwitch();
      const config = {
        version: 1,
        ports: { "1": { vlan_mode: "strict", vlan_receive: "only_untagged", default_vlan: 100 } },
        vlans: [{ id: 100, members: [17] }],
      };
      await expect(
        applyTool.handler({ routerId: "switch-01", config, dryRun: false }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_LOCKOUT_RISK" });
      expect(sw.client.postRaw).not.toHaveBeenCalled();
      // The management flag does not silence a lockout warning.
      await expect(
        applyTool.handler(
          { routerId: "switch-01", config, dryRun: false, includeManagement: true },
          makeContext(sw),
        ),
      ).rejects.toMatchObject({ code: "SWOS_LOCKOUT_RISK" });
      await applyTool.handler(
        { routerId: "switch-01", config, dryRun: false, acceptLockoutRisk: true },
        makeContext(sw),
      );
      expect(sw.posts).toEqual(["vlan.b", "fwd.b"]);
    });

    it("refuses forcing the speed of a linked port unless acceptLockoutRisk is set", async () => {
      const sw = makeSwitch();
      const config = { version: 1, ports: { "17": { auto_negotiation: false, speed: "1G" } } };
      await expect(
        applyTool.handler({ routerId: "switch-01", config, dryRun: false }, makeContext(sw)),
      ).rejects.toMatchObject({ code: "SWOS_LOCKOUT_RISK" });
      expect(sw.client.postRaw).not.toHaveBeenCalled();

      await applyTool.handler(
        {
          routerId: "switch-01",
          config,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw),
      );
      expect(sw.posts).toEqual(["link.b"]);

      // The export carries the forced speed and applies back without a change.
      const exported = await getTool.handler({ routerId: "switch-01" }, makeContext(sw));
      const { config: doc, yaml } = exported.structuredContent as {
        config: { ports: Record<string, unknown> };
        yaml: string;
      };
      expect(doc.ports["17"]).toMatchObject({
        auto_negotiation: false,
        speed: "1G",
        full_duplex: true,
      });
      const back = await applyTool.handler(
        {
          routerId: "switch-01",
          config: yaml,
          dryRun: false,
          includeManagement: true,
          acceptLockoutRisk: true,
        },
        makeContext(sw),
      );
      expect((back.structuredContent as Record<string, unknown>).action).toBe("no_change");
    });
  });
});

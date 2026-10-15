import { describe, it, expect, vi } from "vitest";
import {
  restoreSwosBlobs,
  swosRestoreSequence,
} from "../../../src/domain/tools/change-management-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { StoredSnapshot } from "../../../src/domain/snapshot/snapshot-engine.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";
import type { SwosClient } from "../../../src/adapter/swos-client.js";
import { decodeEndpoint } from "../../../src/adapter/swos-protocol.js";

const NEW_TABLE = "[{vid:0x0064,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x000080}]";
const OLD_TABLE = "[{vid:0x0001,nm:'',piso:0x01,lrn:0x01,mrr:0x00,igmp:0x00,mbr:0x03ffff}]";

const clientWith = (vlan: string) => ({ getRaw: vi.fn(async () => vlan) }) as unknown as SwosClient;

describe("swosRestoreSequence", () => {
  it("restores per-port settings between a union table and the old table, system last", async () => {
    const steps = await swosRestoreSequence(clientWith(NEW_TABLE), [
      { endpoint: "vlan.b", blob: OLD_TABLE },
      { endpoint: "fwd.b", blob: "{vlan:[0x01]}" },
      { endpoint: "link.b", blob: "{en:0x01}" },
      { endpoint: "snmp.b", blob: "{en:0x01}" },
      { endpoint: "sys.b", blob: "{id:''}" },
    ]);
    expect(steps.map((s) => s.endpoint)).toEqual([
      "vlan.b",
      "fwd.b",
      "link.b",
      "vlan.b",
      "snmp.b",
      "sys.b",
    ]);
    const union = decodeEndpoint("vlan.b", steps[0].blob, 18) as Record<string, unknown>[];
    expect(union.map((r) => r.vid)).toEqual([1, 100]);
    expect(steps[3].blob).toBe(OLD_TABLE);
  });

  it("re-posts a lone snapshot as it is", async () => {
    const client = clientWith(NEW_TABLE);
    const steps = await swosRestoreSequence(client, [{ endpoint: "poe.b", blob: "{i01:[0x02]}" }]);
    expect(steps).toEqual([{ endpoint: "poe.b", blob: "{i01:[0x02]}" }]);
    expect(client.getRaw).not.toHaveBeenCalled();
  });

  it("does not merge SwOS Lite tables, whose rows carry no vid", async () => {
    const client = {
      getRaw: vi.fn(async () => "[{i01:0x0001,i02:0x03ff}]"),
    } as unknown as SwosClient;
    const sequence = await swosRestoreSequence(client, [
      { endpoint: "fwd.b", blob: "{i15:[0x00,0x00]}" },
      { endpoint: "vlan.b", blob: "[{i01:0x0001,i02:0x0003}]" },
    ]);
    expect(sequence.map((s) => `${s.endpoint}${s.step ? ` (${s.step})` : ""}`)).toEqual([
      "fwd.b",
      "vlan.b",
    ]);
  });
});

describe("restoreSwosBlobs", () => {
  const snapshots = (...eps: string[]): StoredSnapshot[] =>
    eps.map((path) => ({ path, blob: `{${path.replace(".b", "")}:0x01}` })) as StoredSnapshot[];

  it("reports the written and the pending steps when a write fails partway", async () => {
    const postRaw = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(
        new MikroMCPError({
          category: ErrorCategory.ROUTER_TIMEOUT,
          code: "SWOS_REQUEST_TIMEOUT",
          message: "timed out",
          recoverability: { retryable: false, suggestedAction: "" },
        }),
      );
    const context = {
      routerId: "switch-01",
      swosClient: { postRaw, getRaw: vi.fn() },
    } as unknown as ToolContext;
    const err = await restoreSwosBlobs(
      snapshots("fwd.b", "link.b", "sys.b"),
      "j1",
      false,
      context,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "SWOS_ROLLBACK_INCOMPLETE",
      details: {
        written: ["fwd.b"],
        failedAt: "link.b",
        pending: ["sys.b"],
        possiblyWritten: "link.b",
        cause: "SWOS_REQUEST_TIMEOUT",
      },
    });
    expect((err as Error).message).toContain("still to restore: sys.b");
  });

  it("restores every snapshot and names them when all writes answer", async () => {
    const postRaw = vi.fn(async () => "");
    const context = {
      routerId: "switch-01",
      swosClient: { postRaw, getRaw: vi.fn() },
    } as unknown as ToolContext;
    const result = await restoreSwosBlobs(snapshots("link.b", "sys.b"), "j2", false, context);
    expect(postRaw.mock.calls.map((c) => c[0])).toEqual(["link.b", "sys.b"]);
    expect((result.structuredContent as { action: string }).action).toBe("rolled_back");
  });
});

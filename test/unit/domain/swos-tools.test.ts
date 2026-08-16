import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swosTools } from "../../../src/domain/tools/swos-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { snapshotPathsFor } from "../../../src/domain/tools/tool-definition.js";
import type { SwosClient } from "../../../src/adapter/swos-client.js";
import type { RouterConfig } from "../../../src/types.js";
import { decodeEndpoint, dumpBlob, parseWireBlob } from "../../../src/adapter/swos-protocol.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures/swos");
const blob = (name: string) => readFileSync(join(FIXTURES, name), "utf8").trim();

const [listTool, statusTool, getTool, writeTool] = swosTools;

function makeRouterConfig(): RouterConfig {
  return {
    id: "switch-01",
    host: "192.168.88.2",
    port: 80,
    deviceType: "swos",
    tls: { enabled: false, rejectUnauthorized: true },
    credentials: { source: "env", envPrefix: "SWITCH_CORE" },
    tags: [],
    rosVersion: "swos",
  };
}

/** A SwOS client backed by the real fixtures and the real codec. */
function makeSwosClient(overrides: Partial<Record<string, string>> = {}) {
  const store = new Map<string, string>();
  const written: { endpoint: string; body: string }[] = [];

  const load = (endpoint: string): string => {
    if (store.has(endpoint)) return store.get(endpoint)!;
    return overrides[endpoint] ?? blob(endpoint);
  };

  const client = {
    get: vi.fn(async (endpoint: string) => decodeEndpoint(endpoint, load(endpoint))),
    getRaw: vi.fn(async (endpoint: string) => load(endpoint)),
    readBlob: vi.fn(async (endpoint: string) => parseWireBlob(load(endpoint))),
    readBlobForWrite: vi.fn(async (endpoint: string) => {
      const raw = load(endpoint);
      const wire = parseWireBlob(raw);
      const reencoded = dumpBlob(wire);
      if (reencoded !== raw.trim()) {
        throw new MikroMCPError({
          category: ErrorCategory.VALIDATION,
          code: "SWOS_ROUNDTRIP_MISMATCH",
          message: `cannot re-encode ${endpoint} byte-for-byte`,
          details: { endpoint, received: raw.trim(), reencoded },
          recoverability: { retryable: false, suggestedAction: "" },
        });
      }
      return wire;
    }),
    writeBlob: vi.fn(async (endpoint: string, wire: unknown) => {
      const body = dumpBlob(wire);
      written.push({ endpoint, body });
      store.set(endpoint, body);
      return "";
    }),
    postRaw: vi.fn(async () => ""),
    close: vi.fn(),
  };

  return { client, written };
}

function makeContext(swos?: ReturnType<typeof makeSwosClient>): ToolContext {
  const swosClient = swos?.client as unknown as SwosClient | undefined;
  return {
    routerId: "switch-01",
    correlationId: "test-corr",
    routerConfig: makeRouterConfig(),
    identity: {
      id: "superadmin-builtin",
      role: "superadmin" as const,
      allowedRouters: [],
      allowedToolPatterns: [],
    },
    swosClient,
    deviceClient: swosClient,
  } as unknown as ToolContext;
}

describe("swosTools", () => {
  describe("metadata", () => {
    it("exports 4 tools", () => expect(swosTools).toHaveLength(4));

    it("exposes the expected tool names", () => {
      expect(swosTools.map((t) => t.name)).toEqual([
        "list_swos_endpoints",
        "get_swos_status",
        "get_swos_endpoint",
        "write_swos_blob",
      ]);
    });

    it("every tool is gated to the swos platform", () => {
      for (const tool of swosTools) expect(tool.platform).toBe("swos");
    });

    it("marks the three read tools readOnly and the write tool destructive", () => {
      expect([listTool, statusTool, getTool].map((t) => t.annotations.readOnlyHint)).toEqual([
        true,
        true,
        true,
      ]);
      expect(writeTool.annotations.readOnlyHint).toBe(false);
      expect(writeTool.annotations.destructiveHint).toBe(true);
    });

    it("snapshots the endpoint it is about to write", () => {
      expect(snapshotPathsFor(writeTool, { endpoint: "poe.b" })).toEqual(["poe.b"]);
      expect(snapshotPathsFor(writeTool, {})).toEqual([]);
    });
  });

  describe("input schema", () => {
    it("rejects extra fields", async () => {
      await expect(
        getTool.handler({ routerId: "switch-01", endpoint: "sys.b", extra: 1 }, makeContext()),
      ).rejects.toThrow();
    });

    it("rejects an unknown endpoint", async () => {
      await expect(
        getTool.handler({ routerId: "switch-01", endpoint: "nope.b" }, makeContext()),
      ).rejects.toThrow();
    });

    it("refuses to write device-generated '!' tables", async () => {
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(
          { routerId: "switch-01", endpoint: "!dhost.b", fields: { mac: "x" } },
          makeContext(swos),
        ),
      ).rejects.toThrow();
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });
  });

  describe("list_swos_endpoints", () => {
    it("lists every endpoint with its decoded field names", async () => {
      const result = await listTool.handler({ routerId: "switch-01" }, makeContext());
      const sc = result.structuredContent as {
        endpoints: { endpoint: string; fields: string[] }[];
      };
      expect(sc.endpoints.map((e) => e.endpoint)).toContain("poe.b");
      expect(sc.endpoints.find((e) => e.endpoint === "poe.b")?.fields).toContain("out");
    });
  });

  describe("get_swos_status", () => {
    it("summarises identity, ports, PoE and SFP", async () => {
      const result = await statusTool.handler(
        { routerId: "switch-01" },
        makeContext(makeSwosClient()),
      );
      expect(result.content).toContain("Model: CSS610-8P-2S+");
      expect(result.content).toContain("p1_uplink-a: up");
      expect(result.content).toContain("PoE:");
      expect(result.content).toContain("SFP modules:");
    });

    it("reports sections that failed instead of silently dropping them", async () => {
      const swos = makeSwosClient();
      swos.client.get.mockImplementation(async (endpoint: string) => {
        if (endpoint === "poe.b") throw new Error("boom");
        return decodeEndpoint(endpoint, blob(endpoint));
      });
      const result = await statusTool.handler({ routerId: "switch-01" }, makeContext(swos));
      expect(result.content).toContain("Sections that failed to load:");
      expect(result.content).toContain("poe.b: boom");
    });

    it("fetches only the requested sections", async () => {
      const swos = makeSwosClient();
      await statusTool.handler({ routerId: "switch-01", include: ["sys.b"] }, makeContext(swos));
      expect(swos.client.get).toHaveBeenCalledTimes(1);
      expect(swos.client.get).toHaveBeenCalledWith("sys.b");
    });
  });

  describe("get_swos_endpoint", () => {
    it("returns the decoded blob", async () => {
      const result = await getTool.handler(
        { routerId: "switch-01", endpoint: "sys.b" },
        makeContext(makeSwosClient()),
      );
      const sc = result.structuredContent as { data: Record<string, unknown> };
      expect(sc.data.model).toBe("CSS610-8P-2S+");
    });

    it("truncates the text rendering but not the structured content", async () => {
      const result = await getTool.handler(
        { routerId: "switch-01", endpoint: "!stats.b" },
        makeContext(makeSwosClient()),
      );
      const sc = result.structuredContent as { data: Record<string, unknown> };
      expect(result.content).toContain("truncated");
      expect(Object.keys(sc.data)).toContain("1");
    });
  });

  describe("write_swos_blob", () => {
    const params = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      routerId: "switch-01",
      endpoint: "poe.b",
      fields,
      ...extra,
    });

    it("throws PLATFORM_MISMATCH when the router is not a SwOS device", async () => {
      await expect(writeTool.handler(params({ out: "off" }), makeContext())).rejects.toMatchObject({
        code: "PLATFORM_MISMATCH",
      });
    });

    it("defaults to a dry run and does not write", async () => {
      const swos = makeSwosClient();
      const result = await writeTool.handler(params({ out: "off" }), makeContext(swos));
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(sc.dryRun).toBe(true);
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
      expect(result.content).toContain("DRY RUN");
    });

    it("broadcasts a scalar across every port of a per-port field", async () => {
      const swos = makeSwosClient();
      const result = await writeTool.handler(
        params({ out: "off" }, { dryRun: false }),
        makeContext(swos),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("written");
      const poe = decodeEndpoint("poe.b", swos.written[0].body) as Record<string, unknown>;
      expect(poe.out).toEqual(Array(10).fill("off"));
    });

    it("maps an option name to its wire index and keeps the field width", async () => {
      const swos = makeSwosClient();
      await writeTool.handler(params({ priority: 3 }, { dryRun: false }), makeContext(swos));
      const wire = parseWireBlob(swos.written[0].body) as Record<string, string[]>;
      // poe.b i02 is a per-port byte array — the new value keeps the 2-digit width.
      expect(wire.i02).toEqual(Array(10).fill("0x03"));
    });

    it("leaves untouched fields byte-identical", async () => {
      const swos = makeSwosClient();
      await writeTool.handler(params({ priority: 3 }, { dryRun: false }), makeContext(swos));
      const before = parseWireBlob(blob("poe.b")) as Record<string, unknown>;
      const after = parseWireBlob(swos.written[0].body) as Record<string, unknown>;
      for (const key of Object.keys(before)) {
        if (key === "i02") continue;
        expect(after[key], key).toEqual(before[key]);
      }
    });

    it("returns no_change when the values already match", async () => {
      const swos = makeSwosClient();
      // poe.b i03 (voltage_level) is "auto" on every port in the fixture.
      const result = await writeTool.handler(
        params({ voltage_level: "auto" }, { dryRun: false }),
        makeContext(swos),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("no_change");
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("rejects an unknown field instead of injecting it into the blob", async () => {
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(params({ poe_out: "auto" }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_UNKNOWN_FIELD" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("refuses a schema field the device's firmware does not expose", async () => {
      // Injecting the key would report success while changing nothing — the
      // failure mode the SwOS community warns about for whole-blob writes.
      const swos = makeSwosClient({ "poe.b": "{i01:[0x00,0x00],i04:[0x01,0x01]}" });
      await expect(
        writeTool.handler(params({ voltage_level: "auto" }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_UNKNOWN_FIELD" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("aborts the write when the codec cannot round-trip this device's blob", async () => {
      // A firmware serializing a bare decimal (12) instead of a hex token is
      // numerically identical but not byte-preserving, so re-encoding the whole
      // blob would rewrite a field nobody asked to change. The guard lives in
      // readBlobForWrite, ahead of any field resolution.
      const swos = makeSwosClient({ "poe.b": "{i01:[0x00,12],i04:[0x01,0x01]}" });
      await expect(
        writeTool.handler(params({ out: "off" }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_ROUNDTRIP_MISMATCH" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("surfaces a round-trip mismatch during a dry run, before any real write", async () => {
      // The preview is where an unverified firmware should be discovered, so the
      // check has to run before the dryRun branch returns.
      const swos = makeSwosClient({ "poe.b": "{i01:[0x00,12],i04:[0x01,0x01]}" });
      await expect(
        writeTool.handler(params({ out: "off" }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_ROUNDTRIP_MISMATCH" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("rejects an invalid option value", async () => {
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(params({ out: "sometimes" }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_INVALID_OPTION" });
    });

    it("rejects a decoded bool array written back over a bitmask scalar", async () => {
      // link.b `enabled` is one bitmask on the wire; get_swos_endpoint renders it
      // as ten booleans, and pasting that back would corrupt the blob.
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(
          {
            routerId: "switch-01",
            endpoint: "link.b",
            fields: { enabled: Array(10).fill(true) },
            dryRun: false,
          },
          makeContext(swos),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIELD_SHAPE_MISMATCH" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("rejects a boolean written over a per-port bitmask", async () => {
      // `enabled: true` would encode as 0x0001 — port 1 on, ports 2-10 off.
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(
          { routerId: "switch-01", endpoint: "link.b", fields: { enabled: true }, dryRun: false },
          makeContext(swos),
        ),
      ).rejects.toMatchObject({ code: "SWOS_FIELD_SHAPE_MISMATCH" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("rejects an array that does not cover every port", async () => {
      // A 1-entry array would shrink poe.b from ten ports to one.
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(params({ out: ["off"] }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_FIELD_SHAPE_MISMATCH" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("accepts an array that covers every port", async () => {
      const swos = makeSwosClient();
      const out = Array(10).fill("on");
      out[0] = "off";
      const result = await writeTool.handler(params({ out }, { dryRun: false }), makeContext(swos));
      expect((result.structuredContent as Record<string, unknown>).action).toBe("written");
      expect(
        (decodeEndpoint("poe.b", swos.written[0].body) as Record<string, unknown>).out,
      ).toEqual(out);
    });

    it.each([
      ["negative", -1],
      ["fractional", 1.5],
      ["wider than the wire allows", 2 ** 40],
    ])("rejects a %s number instead of encoding a malformed token", async (_label, value) => {
      const swos = makeSwosClient();
      await expect(
        writeTool.handler(params({ priority: value }, { dryRun: false }), makeContext(swos)),
      ).rejects.toMatchObject({ code: "SWOS_VALUE_OUT_OF_RANGE" });
      expect(swos.client.writeBlob).not.toHaveBeenCalled();
    });

    it("reports the firmware as verified for the device the schema was built from", async () => {
      const swos = makeSwosClient();
      const result = await writeTool.handler(params({ priority: 3 }), makeContext(swos));
      const compat = (result.structuredContent as Record<string, unknown>).compatibility as Record<
        string,
        unknown
      >;
      expect(compat).toMatchObject({ model: "CSS610-8P-2S+", version: "2.21", verified: true });
      expect(result.content).not.toContain("⚠️");
    });

    it("warns when the switch runs a firmware the schema was not verified against", async () => {
      const sys = blob("sys.b").replace(
        Buffer.from("2.21").toString("hex"),
        Buffer.from("9.99").toString("hex"),
      );
      const swos = makeSwosClient({ "sys.b": sys });
      const result = await writeTool.handler(params({ priority: 3 }), makeContext(swos));
      const compat = (result.structuredContent as Record<string, unknown>).compatibility as Record<
        string,
        unknown
      >;
      expect(compat).toMatchObject({ version: "9.99", verified: false });
      expect(result.content).toContain("⚠️  Firmware");
    });

    it("previews the write even when the firmware cannot be identified", async () => {
      const swos = makeSwosClient();
      swos.client.get.mockRejectedValue(new Error("sys.b unreachable"));
      const result = await writeTool.handler(params({ priority: 3 }), makeContext(swos));
      expect((result.structuredContent as Record<string, unknown>).action).toBe("dry_run");
      expect(result.content).toContain("compatibility unknown");
    });

    it("names wire keys the schema does not map", async () => {
      const swos = makeSwosClient({ "poe.b": `${blob("poe.b").slice(0, -1)},i99:0x01}` });
      const result = await writeTool.handler(params({ priority: 3 }), makeContext(swos));
      const compat = (result.structuredContent as Record<string, unknown>).compatibility as Record<
        string,
        unknown
      >;
      expect(compat.unmappedKeys).toEqual(["i99"]);
      expect(result.content).toContain("re-sent unchanged: i99");
    });

    it("does not offer record-list endpoints as write targets", () => {
      // A field merge cannot express "edit row 3" — writing vlan.b this way
      // would replace the table, not edit it.
      const endpoints = (
        writeTool.inputSchema as unknown as { shape: Record<string, { options?: string[] }> }
      ).shape.endpoint.options;
      expect(endpoints).not.toContain("vlan.b");
      expect(endpoints).not.toContain("acl.b");
      expect(endpoints).toContain("poe.b");
    });

    it("accepts a raw wire key that exists in the blob", async () => {
      const swos = makeSwosClient();
      const result = await writeTool.handler(
        params({ i02: 4 }, { dryRun: false }),
        makeContext(swos),
      );
      expect((result.structuredContent as Record<string, unknown>).action).toBe("written");
    });
  });
});

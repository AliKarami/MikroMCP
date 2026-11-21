import { describe, it, expect, vi } from "vitest";
import { bridgeTools } from "../../../src/domain/tools/bridge-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";
import type { SshClient } from "../../../src/adapter/ssh-client.js";
import type { FtpClient } from "../../../src/adapter/ftp-client.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { fromWire } from "../helpers/wire.js";

function makeRouterConfig(): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion: "7",
  };
}

function makeContext(
  bridgeRecords: Record<string, unknown>[],
  portRecords: Record<string, unknown>[] = [],
): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "corr",
    routerConfig: makeRouterConfig(),
    identity: {
      id: "superadmin-builtin",
      role: "superadmin" as const,
      allowedRouters: [],
      allowedToolPatterns: [],
    },
    sshClient: { execute: vi.fn().mockResolvedValue("") } as unknown as SshClient,
    ftpClient: {
      upload: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as FtpClient,
    routerClient: {
      get: vi.fn().mockResolvedValueOnce(bridgeRecords).mockResolvedValueOnce(portRecords),
      create: vi.fn().mockResolvedValue({ ".id": "*1" }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listBridgesTool, manageBridgeTool, manageBridgePortTool] = bridgeTools;

describe("bridgeTools", () => {
  describe("metadata", () => {
    it("exports 6 tools", () => {
      expect(bridgeTools.map((t) => t.name)).toEqual([
        "list_bridges",
        "manage_bridge",
        "manage_bridge_port",
        "list_bridge_ports",
        "list_bridge_vlans",
        "manage_bridge_vlan",
      ]);
    });
    it("list_bridges is readOnly", () => {
      expect(listBridgesTool.annotations.readOnlyHint).toBe(true);
    });
    it("manage_bridge is not readOnly", () => {
      expect(manageBridgeTool.annotations.readOnlyHint).toBe(false);
    });
  });

  describe("list_bridges", () => {
    it("returns bridges with port members joined", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", name: "bridge1", running: "true" }],
        [{ ".id": "*2", bridge: "bridge1", interface: "ether2" }],
      );
      const result = await listBridgesTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      const bridges = sc.bridges as Array<Record<string, unknown>>;
      expect(bridges).toHaveLength(1);
      const ports = bridges[0].ports as unknown[];
      expect(ports).toHaveLength(1);
    });
  });

  describe("manage_bridge", () => {
    it("dry-run returns action=dry_run without calling create", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "bridge2",
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("returns already_exists when bridge exists with same name", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([{ ".id": "*1", name: "bridge1" }]),
          create: vi.fn(),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        {
          routerId: "test-router",
          action: "create",
          name: "bridge1",
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("already_exists");
    });

    it("create accepts a 19-char name the old 15-char schema limit rejected", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ ".id": "*2" }),
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        { routerId: "test-router", action: "create", name: "bonding-core-switch" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("created");
    });

    it("create rejects a name longer than 64 chars", async () => {
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: { get: vi.fn().mockResolvedValue([]) } as unknown as RouterOSRestClient,
      };
      await expect(
        manageBridgeTool.handler(
          { routerId: "test-router", action: "create", name: "b".repeat(65) },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BRIDGE_NAME_INVALID" });
    });

    it("remove accepts a 26-char existing name the old 15-char schema limit rejected", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const ctx: ToolContext = {
        routerId: "test-router",
        correlationId: "corr",
        routerConfig: makeRouterConfig(),
        credentials: { username: "admin", password: "secret" },
        routerClient: {
          get: vi.fn().mockResolvedValue([{ ".id": "*3", name: "wireguard-back-to-home-vpn" }]),
          remove,
        } as unknown as RouterOSRestClient,
      };
      const result = await manageBridgeTool.handler(
        { routerId: "test-router", action: "remove", name: "wireguard-back-to-home-vpn" },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("removed");
      expect(remove).toHaveBeenCalledWith("interface/bridge", "*3");
    });
  });

  describe("manage_bridge_port", () => {
    it("rejects extra fields", () => {
      expect(() =>
        manageBridgePortTool.inputSchema.parse({
          action: "add",
          bridge: "b",
          interface: "e",
          extra: 1,
        }),
      ).toThrow();
    });
  });
});

describe("list_bridge_ports", () => {
  const listBridgePortsTool = bridgeTools.find((t) => t.name === "list_bridge_ports")!;
  const ports = [
    {
      ".id": "*0",
      bridge: "bridge1",
      interface: "ether1",
      pvid: 1,
      status: "in-bridge",
      "debug-info": " prio 0x80 num 1\n role:Designated",
    },
    { ".id": "*7", bridge: "bridge1", interface: "wifi1", pvid: 1, status: "in-bridge" },
  ];

  it("is a read-only tool", () => {
    expect(listBridgePortsTool.annotations.readOnlyHint).toBe(true);
  });

  it("returns ports without the debug-info STP dump", async () => {
    const ctx = makeContext(ports);
    const result = await listBridgePortsTool.handler({ routerId: "test-router" }, ctx);
    const sc = result.structuredContent as Record<string, unknown>;
    const rows = sc.ports as Array<Record<string, unknown>>;
    expect(sc.total).toBe(2);
    expect(rows[0]).not.toHaveProperty("debug-info");
    expect(rows[0].interface).toBe("ether1");
    expect(result.content).toContain("interface=wifi1");
  });

  it("passes bridge and interface filters to the router query", async () => {
    const ctx = makeContext([ports[0]]);
    await listBridgePortsTool.handler(
      { routerId: "test-router", bridge: "bridge1", interface: "ether1" },
      ctx,
    );
    expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/port", {
      filter: { bridge: "bridge1", interface: "ether1" },
    });
  });

  it("queries without a filter when none is given", async () => {
    const ctx = makeContext(ports);
    await listBridgePortsTool.handler({ routerId: "test-router" }, ctx);
    expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/port", {});
  });
});

type Routes = Record<string, Record<string, unknown>[]>;

/** A context whose `get` answers by path and applies the server-side filter like RouterOS. */
function routedContext(routes: Routes, failPaths: string[] = []): ToolContext {
  const get = vi.fn(async (path: string, options?: { filter?: Record<string, string> }) => {
    if (failPaths.includes(path)) throw new Error(`read of ${path} failed`);
    const rows = routes[path] ?? [];
    const filter = options?.filter;
    if (!filter) return rows;
    return rows.filter((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === v));
  });
  return {
    routerId: "test-router",
    correlationId: "corr",
    routerConfig: makeRouterConfig(),
    routerClient: {
      get,
      create: vi.fn().mockResolvedValue({ ".id": "*NEW" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

function bridge(vlanFiltering: boolean, extra: Record<string, string> = {}) {
  return fromWire([
    {
      ".id": "*B1",
      name: "bridge1",
      "vlan-filtering": vlanFiltering ? "true" : "false",
      pvid: "1",
      ...extra,
    },
  ]);
}

const byName = (name: string) => bridgeTools.find((t) => t.name === name)!;
const listBridgeVlans = byName("list_bridge_vlans");
const manageBridgeVlan = byName("manage_bridge_vlan");
const manageBridge = byName("manage_bridge");
const manageBridgePort = byName("manage_bridge_port");

function sc(result: { structuredContent: Record<string, unknown> }) {
  return result.structuredContent;
}

describe("bridge VLAN filtering", () => {
  describe("metadata", () => {
    it("list_bridge_vlans is read-only and not destructive", () => {
      expect(listBridgeVlans.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    });

    it("manage_bridge_vlan is a destructive, idempotent write snapshotting the VLAN table", () => {
      expect(manageBridgeVlan.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(manageBridgeVlan.snapshotPaths).toEqual(["interface/bridge/vlan"]);
    });

    it("manage_bridge and manage_bridge_port stay destructive writes", () => {
      expect(manageBridge.annotations.destructiveHint).toBe(true);
      expect(manageBridgePort.annotations.destructiveHint).toBe(true);
      expect(manageBridgePort.annotations.readOnlyHint).toBe(false);
    });

    it("manage_bridge description tells the agent how to avoid the vlan-filtering lock-out", () => {
      expect(manageBridge.description).toMatch(/management VLAN/);
      expect(manageBridge.description).toMatch(/tagged/);
      expect(manageBridge.description).toMatch(/PVID/);
    });
  });

  describe("input schema", () => {
    it("list_bridge_vlans applies pagination defaults and rejects extra fields", () => {
      expect(listBridgeVlans.inputSchema.parse({})).toEqual({ limit: 100, offset: 0 });
      expect(() => listBridgeVlans.inputSchema.parse({ extra: 1 })).toThrow();
      expect(() => listBridgeVlans.inputSchema.parse({ vlanId: 4095 })).toThrow();
      expect(() => listBridgeVlans.inputSchema.parse({ vlanId: 0 })).toThrow();
    });

    it("manage_bridge_vlan defaults dryRun to false and rejects extra fields", () => {
      const parsed = manageBridgeVlan.inputSchema.parse({
        action: "add",
        bridge: "bridge1",
        vlanIds: 10,
      }) as Record<string, unknown>;
      expect(parsed.dryRun).toBe(false);
      expect(() =>
        manageBridgeVlan.inputSchema.parse({
          action: "add",
          bridge: "bridge1",
          vlanIds: 10,
          pvid: 10,
        }),
      ).toThrow();
    });

    it.each([10, 1, 4094, "10", "100-110", "10,20,100-110", " 20, 10 "])(
      "manage_bridge_vlan accepts vlanIds %j",
      (vlanIds) => {
        expect(() =>
          manageBridgeVlan.inputSchema.parse({ action: "add", bridge: "bridge1", vlanIds }),
        ).not.toThrow();
      },
    );

    it.each([0, 4095, 1.5, "", "0", "4095", "110-100", "10,", "abc", "10-", "1-4095", "10;20"])(
      "manage_bridge_vlan rejects vlanIds %j",
      (vlanIds) => {
        expect(() =>
          manageBridgeVlan.inputSchema.parse({ action: "add", bridge: "bridge1", vlanIds }),
        ).toThrow();
      },
    );

    it("manage_bridge_vlan rejects an interface name with a comma", () => {
      expect(() =>
        manageBridgeVlan.inputSchema.parse({
          action: "add",
          bridge: "bridge1",
          vlanIds: 10,
          tagged: ["ether1,ether2"],
        }),
      ).toThrow();
    });

    it.each(["admit-all", "admit-only-untagged-and-priority-tagged", "admit-only-vlan-tagged"])(
      "manage_bridge_port accepts frameTypes %s",
      (frameTypes) => {
        expect(() =>
          manageBridgePort.inputSchema.parse({
            action: "update",
            bridge: "bridge1",
            interface: "ether2",
            frameTypes,
          }),
        ).not.toThrow();
      },
    );

    it("manage_bridge_port rejects an unknown frameTypes and an out-of-range pvid", () => {
      const base = { action: "update", bridge: "bridge1", interface: "ether2" };
      expect(() =>
        manageBridgePort.inputSchema.parse({ ...base, frameTypes: "admit-only-tagged" }),
      ).toThrow();
      expect(() => manageBridgePort.inputSchema.parse({ ...base, pvid: 0 })).toThrow();
      expect(() => manageBridgePort.inputSchema.parse({ ...base, pvid: 4095 })).toThrow();
      expect(() => manageBridgePort.inputSchema.parse({ ...base, pvid: 20 })).not.toThrow();
    });

    it("manage_bridge accepts update with vlanFiltering and leaves disabled unset", () => {
      const parsed = manageBridge.inputSchema.parse({
        action: "update",
        name: "bridge1",
        vlanFiltering: true,
      }) as Record<string, unknown>;
      expect(parsed.vlanFiltering).toBe(true);
      expect(parsed.disabled).toBeUndefined();
      expect(parsed.dryRun).toBe(false);
      expect(() =>
        manageBridge.inputSchema.parse({ action: "update", name: "bridge1", pvid: 1 }),
      ).toThrow();
    });
  });

  describe("handler - list_bridge_vlans", () => {
    const entries = fromWire([
      {
        ".id": "*1",
        bridge: "bridge1",
        "vlan-ids": "10",
        tagged: "bridge1,ether5",
        untagged: "ether2",
        "current-tagged": "bridge1,ether5",
        "current-untagged": "ether2",
        dynamic: "false",
        disabled: "false",
      },
      {
        ".id": "*2",
        bridge: "bridge1",
        "vlan-ids": "100-110",
        tagged: "ether5",
        dynamic: "false",
        disabled: "false",
      },
      {
        ".id": "*3",
        bridge: "bridge2",
        "vlan-ids": "1",
        untagged: "bridge2,ether9",
        "current-untagged": "bridge2,ether9",
        dynamic: "true",
        disabled: "false",
      },
    ]);

    it("lists every entry with the curated fields", async () => {
      const ctx = routedContext({ "interface/bridge/vlan": entries });
      const result = await listBridgeVlans.handler({}, ctx);
      expect(sc(result).total).toBe(3);
      expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/vlan", {});
      expect(result.content).toContain("vlan-ids=10 tagged=bridge1,ether5 untagged=ether2");
      expect(result.content).toContain("dynamic=true");
    });

    it("passes the bridge filter to the router", async () => {
      const ctx = routedContext({ "interface/bridge/vlan": entries });
      const result = await listBridgeVlans.handler({ bridge: "bridge2" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith("interface/bridge/vlan", {
        filter: { bridge: "bridge2" },
      });
      expect(sc(result).total).toBe(1);
    });

    it("matches a VLAN id inside a range", async () => {
      const ctx = routedContext({ "interface/bridge/vlan": entries });
      const result = await listBridgeVlans.handler({ vlanId: 105 }, ctx);
      const vlans = sc(result).vlans as Array<Record<string, unknown>>;
      expect(vlans.map((v) => v[".id"])).toEqual(["*2"]);
    });

    it("matches a single numeric vlan-ids the parser turned into a number", async () => {
      const ctx = routedContext({ "interface/bridge/vlan": entries });
      const result = await listBridgeVlans.handler({ vlanId: 10 }, ctx);
      const vlans = sc(result).vlans as Array<Record<string, unknown>>;
      expect(vlans.map((v) => v[".id"])).toEqual(["*1"]);
    });

    it("paginates client-side", async () => {
      const ctx = routedContext({ "interface/bridge/vlan": entries });
      const result = await listBridgeVlans.handler({ limit: 1, offset: 1 }, ctx);
      expect(sc(result)).toMatchObject({ total: 3, hasMore: true, offset: 1, limit: 1 });
      expect((sc(result).vlans as unknown[]).length).toBe(1);
    });
  });

  describe("handler - manage_bridge_vlan add", () => {
    it("creates the entry with normalised vlan-ids and comma-joined port lists", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      const result = await manageBridgeVlan.handler(
        {
          action: "add",
          bridge: "bridge1",
          vlanIds: "20,10,11,12",
          tagged: ["ether5", "bridge1"],
          untagged: ["ether2"],
          comment: "office",
        },
        ctx,
      );
      expect(sc(result).action).toBe("created");
      expect(sc(result).warnings).toEqual([]);
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/bridge/vlan", {
        bridge: "bridge1",
        "vlan-ids": "10-12,20",
        tagged: "bridge1,ether5",
        untagged: "ether2",
        comment: "office",
      });
    });

    it("dry-run returns the diff and writes nothing", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: 30, tagged: ["ether5"], dryRun: true },
        ctx,
      );
      expect(sc(result).action).toBe("dry_run");
      expect(sc(result).diff).toEqual([
        { property: "bridge", before: null, after: "bridge1" },
        { property: "vlan-ids", before: null, after: "30" },
        { property: "tagged", before: null, after: "ether5" },
      ]);
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("returns already_exists when the VLAN set and ports match in another order", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          {
            ".id": "*5",
            bridge: "bridge1",
            "vlan-ids": "10,20",
            tagged: "bridge1,ether5",
            untagged: "",
            dynamic: "false",
          },
        ]),
      });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: "20,10", tagged: ["ether5", "bridge1"] },
        ctx,
      );
      expect(sc(result).action).toBe("already_exists");
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("treats a stored range as equal to the same ids listed one by one", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          { ".id": "*6", bridge: "bridge1", "vlan-ids": "100-102", tagged: "ether5" },
        ]),
      });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: "102,100,101", tagged: ["ether5"] },
        ctx,
      );
      expect(sc(result).action).toBe("already_exists");
    });

    it("matches a single vlan-ids the parser turned into a number", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          { ".id": "*7", bridge: "bridge1", "vlan-ids": "10", untagged: "ether2" },
        ]),
      });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: 10, untagged: ["ether2"] },
        ctx,
      );
      expect(sc(result).action).toBe("already_exists");
    });

    it("throws CONFLICT when the entry exists with different ports", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          { ".id": "*7", bridge: "bridge1", "vlan-ids": "10", untagged: "ether2" },
        ]),
      });
      await expect(
        manageBridgeVlan.handler(
          { action: "add", bridge: "bridge1", vlanIds: 10, untagged: ["ether3"] },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFLICT,
        code: "BRIDGE_VLAN_CONFLICT",
      });
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when the VLANs overlap another static entry", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          { ".id": "*8", bridge: "bridge1", "vlan-ids": "10,20", tagged: "ether5" },
        ]),
      });
      await expect(
        manageBridgeVlan.handler(
          { action: "add", bridge: "bridge1", vlanIds: "20-30", tagged: ["ether5"] },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFLICT,
        code: "BRIDGE_VLAN_OVERLAP",
      });
    });

    it("ignores a dynamic entry for the same VLAN and creates a static one", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": fromWire([
          {
            ".id": "*9",
            bridge: "bridge1",
            "vlan-ids": "1",
            "current-untagged": "bridge1,ether2",
            dynamic: "true",
          },
        ]),
      });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: 1, tagged: ["bridge1"] },
        ctx,
      );
      expect(sc(result).action).toBe("created");
    });

    it("rejects a port that is both tagged and untagged", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      await expect(
        manageBridgeVlan.handler(
          {
            action: "add",
            bridge: "bridge1",
            vlanIds: 10,
            tagged: ["ether5", "ether2"],
            untagged: ["ether2"],
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
        code: "BRIDGE_VLAN_PORT_OVERLAP",
        details: expect.objectContaining({ both: ["ether2"] }),
      });
      expect(ctx.routerClient.create).not.toHaveBeenCalled();
    });

    it("warns in content and structuredContent when the bridge has vlan-filtering off", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(false) });
      const result = await manageBridgeVlan.handler(
        { action: "add", bridge: "bridge1", vlanIds: 10, untagged: ["ether2"], dryRun: true },
        ctx,
      );
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/vlan-filtering off/);
      expect(result.content).toContain("vlan-filtering off");
    });

    it("throws NOT_FOUND when the bridge does not exist", async () => {
      const ctx = routedContext({});
      await expect(
        manageBridgeVlan.handler({ action: "add", bridge: "bridge9", vlanIds: 10 }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "BRIDGE_NOT_FOUND" });
    });
  });

  describe("handler - manage_bridge_vlan update", () => {
    const table = () =>
      fromWire([
        {
          ".id": "*A",
          bridge: "bridge1",
          "vlan-ids": "10,20",
          tagged: "bridge1,ether5",
          untagged: "",
          comment: "trunk",
          dynamic: "false",
          disabled: "false",
        },
        {
          ".id": "*D",
          bridge: "bridge1",
          "vlan-ids": "1",
          "current-untagged": "bridge1,ether2",
          dynamic: "true",
        },
      ]);

    it("replaces the tagged list and keeps what was not passed", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        {
          action: "update",
          bridge: "bridge1",
          vlanIds: "20,10",
          tagged: ["ether6", "bridge1", "ether5"],
        },
        ctx,
      );
      expect(sc(result).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/bridge/vlan", "*A", {
        tagged: "bridge1,ether5,ether6",
      });
    });

    it("returns no_change when nothing differs", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        {
          action: "update",
          bridge: "bridge1",
          vlanIds: "10,20",
          tagged: ["ether5", "bridge1"],
          comment: "trunk",
          disabled: false,
        },
        ctx,
      );
      expect(sc(result).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("dry-run returns the diff without writing", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        { action: "update", bridge: "bridge1", vlanIds: "10,20", comment: "core", dryRun: true },
        ctx,
      );
      expect(sc(result).action).toBe("dry_run");
      expect(sc(result).diff).toEqual([{ property: "comment", before: "trunk", after: "core" }]);
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when no static entry has exactly those VLANs", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      await expect(
        manageBridgeVlan.handler(
          { action: "update", bridge: "bridge1", vlanIds: 10, tagged: ["ether5"] },
          ctx,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.NOT_FOUND,
        code: "BRIDGE_VLAN_NOT_FOUND",
        details: expect.objectContaining({ overlapping: [{ id: "*A", "vlan-ids": "10,20" }] }),
      });
    });

    it("refuses to modify a dynamic entry", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      await expect(
        manageBridgeVlan.handler(
          { action: "update", bridge: "bridge1", vlanIds: 1, tagged: ["ether5"] },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.VALIDATION, code: "BRIDGE_VLAN_DYNAMIC" });
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("rejects an untagged port that stays tagged from the existing entry", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      await expect(
        manageBridgeVlan.handler(
          { action: "update", bridge: "bridge1", vlanIds: "10,20", untagged: ["ether5"] },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "BRIDGE_VLAN_PORT_OVERLAP" });
    });

    it("warns when the update drops the bridge itself while vlan-filtering is on", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        { action: "update", bridge: "bridge1", vlanIds: "10,20", tagged: ["ether5"], dryRun: true },
        ctx,
      );
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/drops "bridge1" itself/);
      expect(result.content).toContain("⚠️");
    });

    it("warns that the change has no effect while vlan-filtering is off", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(false),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        { action: "update", bridge: "bridge1", vlanIds: "10,20", tagged: ["ether5"] },
        ctx,
      );
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/vlan-filtering off/);
    });
  });

  describe("handler - manage_bridge_vlan remove", () => {
    const table = () =>
      fromWire([
        { ".id": "*A", bridge: "bridge1", "vlan-ids": "30", tagged: "ether5", dynamic: "false" },
        { ".id": "*B", bridge: "bridge1", "vlan-ids": "99", tagged: "bridge1", dynamic: "false" },
        { ".id": "*D", bridge: "bridge1", "vlan-ids": "1", dynamic: "true" },
      ]);

    it("removes the matching entry", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        { action: "remove", bridge: "bridge1", vlanIds: "30" },
        ctx,
      );
      expect(sc(result)).toMatchObject({ action: "removed", id: "*A", warnings: [] });
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/bridge/vlan", "*A");
    });

    it("dry-run removes nothing and warns when the bridge itself loses the VLAN", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      const result = await manageBridgeVlan.handler(
        { action: "remove", bridge: "bridge1", vlanIds: 99, dryRun: true },
        ctx,
      );
      expect(sc(result).action).toBe("dry_run");
      expect((sc(result).warnings as string[])[0]).toMatch(/drops "bridge1" itself/);
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND when the entry is missing", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      await expect(
        manageBridgeVlan.handler({ action: "remove", bridge: "bridge1", vlanIds: 40 }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "BRIDGE_VLAN_NOT_FOUND" });
    });

    it("refuses to remove a dynamic entry", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/vlan": table(),
      });
      await expect(
        manageBridgeVlan.handler({ action: "remove", bridge: "bridge1", vlanIds: 1 }, ctx),
      ).rejects.toMatchObject({ code: "BRIDGE_VLAN_DYNAMIC" });
      expect(ctx.routerClient.remove).not.toHaveBeenCalled();
    });
  });

  describe("handler - manage_bridge_port VLAN settings", () => {
    const port = (extra: Record<string, string> = {}) =>
      fromWire([
        {
          ".id": "*P2",
          bridge: "bridge1",
          interface: "ether2",
          pvid: "20",
          "frame-types": "admit-only-untagged-and-priority-tagged",
          "ingress-filtering": "true",
          dynamic: "false",
          ...extra,
        },
      ]);

    it("add without VLAN settings keeps the old behaviour: no bridge read, plain body", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      const result = await manageBridgePort.handler(
        { action: "add", bridge: "bridge1", interface: "ether3" },
        ctx,
      );
      expect(sc(result).action).toBe("created");
      expect(sc(result)).not.toHaveProperty("warnings");
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/bridge/port", {
        bridge: "bridge1",
        interface: "ether3",
      });
      expect(ctx.routerClient.get).toHaveBeenCalledTimes(1);
    });

    it("add returns already_exists without VLAN settings even when the port has them", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      const result = await manageBridgePort.handler(
        { action: "add", bridge: "bridge1", interface: "ether2" },
        ctx,
      );
      expect(sc(result).action).toBe("already_exists");
    });

    it("add sends pvid, frame-types and ingress-filtering and warns when filtering is off", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(false) });
      const result = await manageBridgePort.handler(
        {
          action: "add",
          bridge: "bridge1",
          interface: "ether3",
          pvid: 30,
          frameTypes: "admit-only-untagged-and-priority-tagged",
          ingressFiltering: true,
        },
        ctx,
      );
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/bridge/port", {
        bridge: "bridge1",
        interface: "ether3",
        pvid: "30",
        "frame-types": "admit-only-untagged-and-priority-tagged",
        "ingress-filtering": "true",
      });
      expect((sc(result).warnings as string[])[0]).toMatch(/vlan-filtering off/);
      expect(result.content).toContain("vlan-filtering off");
    });

    it("add returns already_exists when the requested settings match the parsed record", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      const result = await manageBridgePort.handler(
        { action: "add", bridge: "bridge1", interface: "ether2", pvid: 20, ingressFiltering: true },
        ctx,
      );
      expect(sc(result).action).toBe("already_exists");
    });

    it("add throws CONFLICT when the port exists with a different pvid", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      await expect(
        manageBridgePort.handler(
          { action: "add", bridge: "bridge1", interface: "ether2", pvid: 30 },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT, code: "BRIDGE_PORT_CONFLICT" });
    });

    it("update writes only the changed settings", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(false),
        "interface/bridge/port": port(),
      });
      const result = await manageBridgePort.handler(
        {
          action: "update",
          bridge: "bridge1",
          interface: "ether2",
          pvid: 30,
          frameTypes: "admit-only-untagged-and-priority-tagged",
          ingressFiltering: false,
        },
        ctx,
      );
      expect(sc(result).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/bridge/port", "*P2", {
        pvid: "30",
        "ingress-filtering": "false",
      });
      expect(sc(result).diff).toEqual([
        { property: "pvid", before: "20", after: "30" },
        { property: "ingress-filtering", before: "true", after: "false" },
      ]);
    });

    it("update returns no_change when the parsed values already match", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      const result = await manageBridgePort.handler(
        {
          action: "update",
          bridge: "bridge1",
          interface: "ether2",
          pvid: 20,
          frameTypes: "admit-only-untagged-and-priority-tagged",
          ingressFiltering: true,
        },
        ctx,
      );
      expect(sc(result).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("update dry-run warns about the management port when filtering is on", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(true),
        "interface/bridge/port": port(),
      });
      const result = await manageBridgePort.handler(
        { action: "update", bridge: "bridge1", interface: "ether2", pvid: 1, dryRun: true },
        ctx,
      );
      expect(sc(result).action).toBe("dry_run");
      expect((sc(result).warnings as string[])[0]).toMatch(/cut this session/);
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("update throws NOT_FOUND when the interface is not a port of that bridge", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      await expect(
        manageBridgePort.handler(
          { action: "update", bridge: "bridge2", interface: "ether2", pvid: 30 },
          ctx,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "BRIDGE_PORT_NOT_FOUND" });
    });

    it("update without any setting is a validation error", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      await expect(
        manageBridgePort.handler({ action: "update", bridge: "bridge1", interface: "ether2" }, ctx),
      ).rejects.toMatchObject({ code: "BRIDGE_PORT_NOTHING_TO_UPDATE" });
    });

    it("update refuses a dynamic port", async () => {
      const ctx = routedContext({ "interface/bridge/port": port({ dynamic: "true" }) });
      await expect(
        manageBridgePort.handler(
          { action: "update", bridge: "bridge1", interface: "ether2", pvid: 30 },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "BRIDGE_PORT_DYNAMIC" });
    });

    it("remove still removes the port", async () => {
      const ctx = routedContext({ "interface/bridge/port": port() });
      const result = await manageBridgePort.handler(
        { action: "remove", bridge: "bridge1", interface: "ether2" },
        ctx,
      );
      expect(sc(result).action).toBe("removed");
      expect(ctx.routerClient.remove).toHaveBeenCalledWith("interface/bridge/port", "*P2");
    });
  });

  describe("handler - manage_bridge update", () => {
    it("enabling vlan-filtering on a dry run carries the lock-out warning and the setup gaps", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(false),
        "interface/vlan": fromWire([
          { ".id": "*V1", name: "mgmt", interface: "bridge1", "vlan-id": "99" },
        ]),
      });
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: true, dryRun: true },
        ctx,
      );
      expect(sc(result).action).toBe("dry_run");
      expect(sc(result).diff).toEqual([
        { property: "vlan-filtering", before: "false", after: "true" },
      ]);
      const warnings = sc(result).warnings as string[];
      expect(warnings[0]).toMatch(/lock-out/);
      expect(warnings.some((w) => /no static bridge VLAN entries/.test(w))).toBe(true);
      expect(warnings.some((w) => /"mgmt" \(VLAN 99\)/.test(w))).toBe(true);
      expect(result.content).toContain("lock-out");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("enabling vlan-filtering applies the change and still returns the warning", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(false),
        "interface/vlan": fromWire([
          { ".id": "*V1", name: "mgmt", interface: "bridge1", "vlan-id": "99" },
        ]),
        "interface/bridge/vlan": fromWire([
          { ".id": "*E", bridge: "bridge1", "vlan-ids": "99", tagged: "bridge1,ether5" },
        ]),
      });
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: true },
        ctx,
      );
      expect(sc(result).action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/bridge", "*B1", {
        "vlan-filtering": "true",
      });
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/lock-out/);
    });

    it("warns about ports whose PVID does not reach an address on the bridge", async () => {
      const ctx = routedContext({
        "interface/bridge": bridge(false),
        "interface/bridge/vlan": fromWire([
          { ".id": "*E", bridge: "bridge1", "vlan-ids": "20", untagged: "ether2" },
        ]),
        "interface/bridge/port": fromWire([
          { ".id": "*P1", bridge: "bridge1", interface: "ether1", pvid: "1" },
          { ".id": "*P2", bridge: "bridge1", interface: "ether2", pvid: "20" },
        ]),
        "ip/address": fromWire([{ ".id": "*I", address: "192.168.88.1/24", interface: "bridge1" }]),
      });
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: true, dryRun: true },
        ctx,
      );
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain("192.168.88.1/24");
      expect(warnings[1]).toContain("ether2 (PVID 20)");
      expect(warnings[1]).not.toContain("ether1");
    });

    it("falls back to a verify-manually warning when the setup cannot be read", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(false) }, ["interface/vlan"]);
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: true, dryRun: true },
        ctx,
      );
      const warnings = sc(result).warnings as string[];
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toMatch(/Could not read/);
    });

    it("returns no_change when vlan-filtering is already on", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: true },
        ctx,
      );
      expect(sc(result).action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });

    it("disabling vlan-filtering carries no warning", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      const result = await manageBridge.handler(
        { action: "update", name: "bridge1", vlanFiltering: false, comment: "lan" },
        ctx,
      );
      expect(sc(result).warnings).toEqual([]);
      expect(ctx.routerClient.update).toHaveBeenCalledWith("interface/bridge", "*B1", {
        "vlan-filtering": "false",
        comment: "lan",
      });
    });

    it("throws NOT_FOUND for a missing bridge", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(true) });
      await expect(
        manageBridge.handler({ action: "update", name: "bridge9", vlanFiltering: true }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND, code: "BRIDGE_NOT_FOUND" });
    });

    it("create sends vlan-filtering when given", async () => {
      const ctx = routedContext({});
      await manageBridge.handler({ action: "create", name: "bridge2", vlanFiltering: true }, ctx);
      expect(ctx.routerClient.create).toHaveBeenCalledWith("interface/bridge", {
        name: "bridge2",
        disabled: "false",
        "vlan-filtering": "true",
      });
    });

    it("create throws CONFLICT when the bridge exists with another vlan-filtering", async () => {
      const ctx = routedContext({ "interface/bridge": bridge(false) });
      await expect(
        manageBridge.handler({ action: "create", name: "bridge1", vlanFiltering: true }, ctx),
      ).rejects.toMatchObject({ category: ErrorCategory.CONFLICT, code: "BRIDGE_CONFLICT" });
    });
  });
});

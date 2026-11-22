import { describe, it, expect, vi } from "vitest";
import { ipv6Tools } from "../../../src/domain/tools/ipv6-tools.js";
import { snapshotPathsFor, type ToolContext } from "../../../src/domain/tools/tool-definition.js";
import { ErrorCategory } from "../../../src/domain/errors/error-types.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

const tool = (name: string) => ipv6Tools.find((t) => t.name === name)!;
const listAddresses = tool("list_ipv6_addresses");
const manageAddress = tool("manage_ipv6_address");
const listNeighbors = tool("list_ipv6_neighbors");
const listDhcpv6Clients = tool("list_dhcpv6_clients");

function makeContext(records: WireRecord[]) {
  const get = vi.fn().mockResolvedValue(fromWire(records));
  const create = vi.fn().mockResolvedValue({ ".id": "*9", address: "2001:db8::1/64" });
  const update = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const context = {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: { get, create, update, remove } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
  return { context, get, create, update, remove };
}

const staticAddress: WireRecord = {
  ".id": "*1",
  address: "2001:db8::1/64",
  interface: "bridge",
  "actual-interface": "bridge",
  "eui-64": "false",
  advertise: "true",
  "no-dad": "false",
  "from-pool": "",
  dynamic: "false",
  invalid: "false",
  disabled: "false",
  comment: "lan",
};

const linkLocal: WireRecord = {
  ".id": "*2",
  address: "fe80::4aa9:8aff:fe01:203/64",
  interface: "bridge",
  "eui-64": "false",
  advertise: "false",
  "no-dad": "false",
  dynamic: "true",
  "link-local": "true",
  invalid: "false",
  disabled: "false",
};

const eui64Address: WireRecord = {
  ".id": "*3",
  address: "2001:db8:1:0:4aa9:8aff:fe01:203/64",
  interface: "ether2",
  "eui-64": "true",
  advertise: "true",
  "no-dad": "false",
  "from-pool": "",
  dynamic: "false",
  disabled: "false",
};

const poolAddress: WireRecord = {
  ".id": "*4",
  address: "2001:db8:abcd:10::1/64",
  interface: "vlan10",
  "eui-64": "false",
  advertise: "true",
  "no-dad": "false",
  "from-pool": "pd-pool",
  dynamic: "false",
  disabled: "false",
};

const base = { routerId: "test-router" };

describe("ipv6 tools", () => {
  describe("metadata", () => {
    it("exports the four IPv6 tools", () => {
      expect(ipv6Tools.map((t) => t.name)).toEqual([
        "list_ipv6_addresses",
        "manage_ipv6_address",
        "list_ipv6_neighbors",
        "list_dhcpv6_clients",
      ]);
    });

    it.each([listAddresses, listNeighbors, listDhcpv6Clients])("$name is read-only", (readTool) => {
      expect(readTool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    it("manage_ipv6_address is a destructive, idempotent write that snapshots ipv6/address", () => {
      expect(manageAddress.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(snapshotPathsFor(manageAddress, {})).toEqual(["ipv6/address"]);
    });
  });

  describe("input schema", () => {
    it("list tools apply pagination defaults and reject extra fields", () => {
      for (const readTool of [listAddresses, listNeighbors, listDhcpv6Clients]) {
        const parsed = readTool.inputSchema.parse({}) as Record<string, unknown>;
        expect(parsed.limit).toBe(100);
        expect(parsed.offset).toBe(0);
        expect(() => readTool.inputSchema.parse({ bogus: 1 })).toThrow();
        expect(() => readTool.inputSchema.parse({ limit: 501 })).toThrow();
      }
      expect((listAddresses.inputSchema.parse({}) as { disabled: string }).disabled).toBe("all");
    });

    it("manage_ipv6_address normalises the address and applies defaults", () => {
      const parsed = manageAddress.inputSchema.parse({
        action: "add",
        address: "2001:DB8:0::1/64",
        interface: "bridge",
      }) as Record<string, unknown>;
      expect(parsed.address).toBe("2001:db8::1/64");
      expect(parsed.eui64).toBe(false);
      expect(parsed.disabled).toBe(false);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.advertise).toBeUndefined();
      expect(parsed.noDad).toBeUndefined();
    });

    it("manage_ipv6_address rejects a missing prefix, IPv4, bad prefix and extra fields", () => {
      const ok = { action: "add", interface: "bridge" };
      expect(() => manageAddress.inputSchema.parse({ ...ok, address: "2001:db8::1" })).toThrow();
      expect(() => manageAddress.inputSchema.parse({ ...ok, address: "192.0.2.1/24" })).toThrow();
      expect(() =>
        manageAddress.inputSchema.parse({ ...ok, address: "2001:db8::1/129" }),
      ).toThrow();
      expect(() =>
        manageAddress.inputSchema.parse({ ...ok, address: "2001:db8::1/64", bogus: true }),
      ).toThrow();
      expect(() =>
        manageAddress.inputSchema.parse({ ...ok, address: "2001:db8::1/64", action: "move" }),
      ).toThrow();
    });
  });

  describe("list_ipv6_addresses handler", () => {
    it("lists addresses with compact content and filters by interface server-side", async () => {
      const { context, get } = makeContext([staticAddress, linkLocal]);
      const result = await listAddresses.handler({ ...base, interface: "bridge" }, context);
      expect(get).toHaveBeenCalledWith("ipv6/address", { filter: { interface: "bridge" } });
      expect(result.structuredContent.total).toBe(2);
      expect(result.content).toContain("IPv6 addresses on test-router: 1-2 of 2.");
      expect(result.content).toContain("address=2001:db8::1/64 interface=bridge");
      expect(result.content).toContain("advertise=true");
    });

    it("filters by disabled state and paginates", async () => {
      const disabled = { ...eui64Address, disabled: "true" };
      const { context } = makeContext([staticAddress, linkLocal, disabled]);
      const enabled = await listAddresses.handler(
        { ...base, disabled: "false", limit: 1 },
        context,
      );
      expect(enabled.structuredContent.total).toBe(2);
      expect(enabled.structuredContent.hasMore).toBe(true);
      const off = await listAddresses.handler({ ...base, disabled: "true" }, context);
      expect(off.structuredContent.total).toBe(1);
    });
  });

  describe("manage_ipv6_address handler - add", () => {
    const add = { ...base, action: "add", interface: "bridge" };

    it("creates the address with only the fields given", async () => {
      const { context, create } = makeContext([linkLocal]);
      const result = await manageAddress.handler(
        { ...add, address: "2001:db8::2/64", advertise: true },
        context,
      );
      expect(result.structuredContent.action).toBe("created");
      expect(create).toHaveBeenCalledWith("ipv6/address", {
        address: "2001:db8::2/64",
        interface: "bridge",
        disabled: "false",
        advertise: "true",
      });
    });

    it("returns already_exists for the same address written differently", async () => {
      const { context, create } = makeContext([staticAddress]);
      const result = await manageAddress.handler(
        { ...add, address: "2001:0DB8:0:0::0001/64", comment: "lan" },
        context,
      );
      expect(result.structuredContent.action).toBe("already_exists");
      expect(create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when the same address has different settings", async () => {
      const { context, create } = makeContext([staticAddress]);
      await expect(
        manageAddress.handler(
          { ...add, address: "2001:db8::1/64", comment: "lan", advertise: false },
          context,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFLICT,
        code: "IPV6_ADDRESS_CONFLICT",
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("throws CONFLICT when the address is on another interface", async () => {
      const { context } = makeContext([staticAddress]);
      await expect(
        manageAddress.handler(
          { ...add, address: "2001:db8::1/64", interface: "ether5", comment: "lan" },
          context,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.CONFLICT,
        message: expect.stringContaining("already assigned to interface bridge"),
      });
    });

    it("refuses to add a static copy of a dynamic address", async () => {
      const { context, create } = makeContext([linkLocal]);
      await expect(
        manageAddress.handler({ ...add, address: "FE80::4AA9:8AFF:FE01:203/64" }, context),
      ).rejects.toMatchObject({ code: "IPV6_ADDRESS_DYNAMIC" });
      expect(create).not.toHaveBeenCalled();
    });

    it("dry run returns the planned fields without creating", async () => {
      const { context, create } = makeContext([]);
      const result = await manageAddress.handler(
        { ...add, address: "2001:db8::2/64", noDad: true, comment: "x", dryRun: true },
        context,
      );
      expect(result.structuredContent.action).toBe("dry_run");
      expect(result.structuredContent.diff).toContainEqual({
        property: "no-dad",
        before: null,
        after: "true",
      });
      expect(create).not.toHaveBeenCalled();
    });

    describe("eui64", () => {
      const euiAdd = { ...add, interface: "ether2", eui64: true };

      it("matches the router-derived address by its prefix", async () => {
        const { context, create } = makeContext([eui64Address]);
        const result = await manageAddress.handler(
          { ...euiAdd, address: "2001:db8:1::/64", advertise: true },
          context,
        );
        expect(result.structuredContent.action).toBe("already_exists");
        expect(create).not.toHaveBeenCalled();
      });

      it("creates with eui-64 set when the prefix is new", async () => {
        const { context, create } = makeContext([eui64Address]);
        await manageAddress.handler({ ...euiAdd, address: "2001:db8:2::/64" }, context);
        expect(create).toHaveBeenCalledWith("ipv6/address", {
          address: "2001:db8:2::/64",
          interface: "ether2",
          disabled: "false",
          "eui-64": "true",
        });
      });

      it("rejects a prefix longer than /64", async () => {
        const { context, get } = makeContext([]);
        await expect(
          manageAddress.handler({ ...euiAdd, address: "2001:db8:1::/80" }, context),
        ).rejects.toMatchObject({
          category: ErrorCategory.VALIDATION,
          code: "IPV6_EUI64_PREFIX_TOO_LONG",
        });
        expect(get).not.toHaveBeenCalled();
      });

      it("reports a plain add of an EUI-64 address as a conflict on eui-64", async () => {
        const { context } = makeContext([eui64Address]);
        await expect(
          manageAddress.handler(
            {
              ...add,
              interface: "ether2",
              address: "2001:db8:1:0:4aa9:8aff:fe01:203/64",
              advertise: true,
            },
            context,
          ),
        ).rejects.toMatchObject({
          code: "IPV6_ADDRESS_CONFLICT",
          message: expect.stringContaining("eui-64 is true, requested false"),
        });
      });
    });

    describe("fromPool", () => {
      const poolAdd = { ...add, interface: "vlan10", fromPool: "pd-pool" };

      it("matches the pool-built address by its suffix", async () => {
        const { context, create } = makeContext([poolAddress]);
        const result = await manageAddress.handler({ ...poolAdd, address: "::1/64" }, context);
        expect(result.structuredContent.action).toBe("already_exists");
        expect(create).not.toHaveBeenCalled();
      });

      it("creates a new suffix from the pool", async () => {
        const { context, create } = makeContext([poolAddress]);
        await manageAddress.handler({ ...poolAdd, address: "::2/64" }, context);
        expect(create).toHaveBeenCalledWith("ipv6/address", {
          address: "::2/64",
          interface: "vlan10",
          disabled: "false",
          "from-pool": "pd-pool",
        });
      });

      it("rejects an address that carries prefix bits", async () => {
        const { context } = makeContext([]);
        await expect(
          manageAddress.handler({ ...poolAdd, address: "2001:db8::1/64" }, context),
        ).rejects.toMatchObject({
          category: ErrorCategory.VALIDATION,
          code: "IPV6_POOL_ADDRESS_HAS_PREFIX",
        });
      });
    });
  });

  describe("manage_ipv6_address handler - update", () => {
    const update = { ...base, action: "update", interface: "bridge" };

    it("updates only the changed fields", async () => {
      const { context, update: mockUpdate } = makeContext([staticAddress]);
      const result = await manageAddress.handler(
        { ...update, address: "2001:db8::1/64", advertise: false, comment: "lan" },
        context,
      );
      expect(result.structuredContent.action).toBe("updated");
      expect(mockUpdate).toHaveBeenCalledWith("ipv6/address", "*1", { advertise: "false" });
    });

    it("returns no_change when nothing differs", async () => {
      const { context, update: mockUpdate } = makeContext([staticAddress]);
      const result = await manageAddress.handler(
        { ...update, address: "2001:DB8::0:1/64", advertise: true, noDad: false },
        context,
      );
      expect(result.structuredContent.action).toBe("no_change");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("dry run shows the diff without writing", async () => {
      const { context, update: mockUpdate } = makeContext([staticAddress]);
      const result = await manageAddress.handler(
        { ...update, address: "2001:db8::1/64", disabled: true, dryRun: true },
        context,
      );
      expect(result.structuredContent.action).toBe("dry_run");
      expect(result.structuredContent.diff).toEqual([
        { property: "disabled", before: "false", after: "true" },
      ]);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND and names the interface the address is on", async () => {
      const { context } = makeContext([staticAddress]);
      await expect(
        manageAddress.handler(
          { ...update, address: "2001:db8::1/64", interface: "ether1" },
          context,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.NOT_FOUND,
        code: "IPV6_ADDRESS_NOT_FOUND",
        message: expect.stringContaining("It is assigned to bridge"),
      });
    });

    it("refuses to change a dynamic address", async () => {
      const { context, update: mockUpdate } = makeContext([linkLocal]);
      await expect(
        manageAddress.handler(
          { ...update, address: "fe80::4aa9:8aff:fe01:203/64", comment: "x" },
          context,
        ),
      ).rejects.toMatchObject({
        category: ErrorCategory.VALIDATION,
        code: "IPV6_ADDRESS_DYNAMIC",
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("manage_ipv6_address handler - remove", () => {
    const remove = { ...base, action: "remove" };

    it("removes a matching address", async () => {
      const { context, remove: mockRemove } = makeContext([linkLocal, staticAddress]);
      const result = await manageAddress.handler(
        { ...remove, address: "2001:db8:0::1/64", interface: "bridge" },
        context,
      );
      expect(result.structuredContent.action).toBe("removed");
      expect(mockRemove).toHaveBeenCalledWith("ipv6/address", "*1");
    });

    it("removes an EUI-64 address by the value list_ipv6_addresses printed", async () => {
      const { context, remove: mockRemove } = makeContext([eui64Address]);
      await manageAddress.handler(
        { ...remove, address: "2001:db8:1:0:4aa9:8aff:fe01:203/64", interface: "ether2" },
        context,
      );
      expect(mockRemove).toHaveBeenCalledWith("ipv6/address", "*3");
    });

    it("dry run does not remove", async () => {
      const { context, remove: mockRemove } = makeContext([poolAddress]);
      const result = await manageAddress.handler(
        { ...remove, address: "::1/64", fromPool: "pd-pool", interface: "vlan10", dryRun: true },
        context,
      );
      expect(result.structuredContent.action).toBe("dry_run");
      expect(result.content).toContain("2001:db8:abcd:10::1/64");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for a missing address", async () => {
      const { context, remove: mockRemove } = makeContext([staticAddress]);
      await expect(
        manageAddress.handler(
          { ...remove, address: "2001:db8::99/64", interface: "bridge" },
          context,
        ),
      ).rejects.toMatchObject({ category: ErrorCategory.NOT_FOUND });
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("refuses to remove a dynamic address", async () => {
      const { context, remove: mockRemove } = makeContext([linkLocal]);
      await expect(
        manageAddress.handler(
          { ...remove, address: "fe80::4aa9:8aff:fe01:203/64", interface: "bridge" },
          context,
        ),
      ).rejects.toMatchObject({ code: "IPV6_ADDRESS_DYNAMIC" });
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });

  describe("list_ipv6_neighbors handler", () => {
    const neighbors: WireRecord[] = [
      {
        ".id": "*1",
        address: "fe80::1",
        interface: "ether1",
        "mac-address": "AA:BB:CC:00:00:01",
        status: "reachable",
        router: "true",
      },
      {
        ".id": "*2",
        address: "2001:db8::5",
        interface: "bridge",
        "mac-address": "AA:BB:CC:00:00:05",
        status: "stale",
        router: "false",
      },
    ];

    it("filters by interface server-side and status client-side", async () => {
      const { context, get } = makeContext(neighbors);
      const result = await listNeighbors.handler(
        { ...base, interface: "ether1", status: "stale" },
        context,
      );
      expect(get).toHaveBeenCalledWith("ipv6/neighbor", { filter: { interface: "ether1" } });
      expect(result.structuredContent.total).toBe(1);
      expect(result.content).toContain("address=2001:db8::5 mac-address=AA:BB:CC:00:00:05");
    });

    it("shows the router flag in content", async () => {
      const { context } = makeContext(neighbors);
      const result = await listNeighbors.handler(base, context);
      expect(result.content).toContain("status=reachable router=true");
    });
  });

  describe("list_dhcpv6_clients handler", () => {
    const clients: WireRecord[] = [
      {
        ".id": "*1",
        interface: "ether1",
        status: "bound",
        request: "prefix,address",
        "pool-name": "pd-pool",
        "pool-prefix-length": "64",
        prefix: "2001:db8:abcd::/56, 1d23h",
        address: "2001:db8:ffff::10/128, 1d23h",
        "add-default-route": "true",
        "use-peer-dns": "true",
        disabled: "false",
      },
      {
        ".id": "*2",
        interface: "ether9",
        status: "searching...",
        request: "prefix",
        "pool-name": "backup",
        disabled: "false",
      },
    ];

    it("lists clients with the delegated prefix in content", async () => {
      const { context, get } = makeContext(clients);
      const result = await listDhcpv6Clients.handler(base, context);
      expect(get).toHaveBeenCalledWith("ipv6/dhcp-client");
      expect(result.structuredContent.total).toBe(2);
      expect(result.content).toContain('prefix="2001:db8:abcd::/56, 1d23h"');
      expect(result.content).toContain("pool-prefix-length=64");
    });

    it("filters by interface and status", async () => {
      const { context } = makeContext(clients);
      const byIface = await listDhcpv6Clients.handler({ ...base, interface: "ether9" }, context);
      expect(byIface.structuredContent.total).toBe(1);
      const byStatus = await listDhcpv6Clients.handler({ ...base, status: "bound" }, context);
      expect((byStatus.structuredContent.clients as { interface: string }[])[0].interface).toBe(
        "ether1",
      );
    });
  });
});

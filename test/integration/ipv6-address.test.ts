import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";

const harness = createHarness();

// RFC 3849 documentation prefix. The non-canonical spelling exercises the
// normalisation the idempotency checks rely on.
const ADDRESS = "2001:db8:ffff::1/64";
const SPELLED_DIFFERENTLY = "2001:0DB8:FFFF:0::0001/64";
const IFACE = "ether1";

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ipv6/address", {
  address: ADDRESS,
  interface: IFACE,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_ipv6_address lifecycle against live CHR", () => {
  it("dry-run add does not touch the router", async () => {
    const result = await runTool(harness.context, "manage_ipv6_address", {
      action: "add",
      address: ADDRESS,
      interface: IFACE,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("add creates the address", async () => {
    const result = await runTool(harness.context, "manage_ipv6_address", {
      action: "add",
      address: ADDRESS,
      interface: IFACE,
      advertise: false,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await findOnRouter();
    expect(onRouter).toBeDefined();
    expect(onRouter!.address).toBe(ADDRESS);
  });

  it("identical add, spelled differently, is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_ipv6_address", {
      action: "add",
      address: SPELLED_DIFFERENTLY,
      interface: IFACE,
      advertise: false,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("list_ipv6_addresses shows it next to the dynamic link-local address", async () => {
    const result = await runTool(harness.context, "list_ipv6_addresses", { interface: IFACE });
    const addresses = result.structuredContent.addresses as Array<Record<string, unknown>>;

    expect(addresses.some((a) => a.address === ADDRESS)).toBe(true);
  });

  it("update changes the comment, then reports no_change", async () => {
    const updated = await runTool(harness.context, "manage_ipv6_address", {
      action: "update",
      address: ADDRESS,
      interface: IFACE,
      comment: "itest",
    });
    expect(updated.structuredContent.action).toBe("updated");
    expect((await findOnRouter())!.comment).toBe("itest");

    const again = await runTool(harness.context, "manage_ipv6_address", {
      action: "update",
      address: ADDRESS,
      interface: IFACE,
      comment: "itest",
    });
    expect(again.structuredContent.action).toBe("no_change");
  });

  it("remove deletes the address", async () => {
    const result = await runTool(harness.context, "manage_ipv6_address", {
      action: "remove",
      address: SPELLED_DIFFERENTLY,
      interface: IFACE,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing address throws NOT_FOUND", async () => {
    const error = await runTool(harness.context, "manage_ipv6_address", {
      action: "remove",
      address: ADDRESS,
      interface: IFACE,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("IPV6_ADDRESS_NOT_FOUND");
  });
});

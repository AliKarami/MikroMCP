import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const NAME = "itest.mikromcp.invalid";
const ADDRESS = "192.0.2.10";

const { find: findOnRouter } = liveResource(harness.context, "ip/dns/static", {
  name: NAME,
});

// A test below adds a second record with the same name, so remove them all.
async function removeLeftover(): Promise<void> {
  const records = await harness.context.routerClient.get<RouterOSRecord>("ip/dns/static", {
    filter: { name: NAME },
  });
  for (const record of records) {
    await harness.context.routerClient.remove("ip/dns/static", record[".id"]);
  }
}

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_dns_entry lifecycle against live CHR", () => {
  it("dry-run add does not touch the router", async () => {
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME,
      address: ADDRESS,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("add creates the A record", async () => {
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME,
      address: ADDRESS,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await findOnRouter();
    expect(onRouter).toBeDefined();
    expect(onRouter!.address).toBe(ADDRESS);
  });

  it("identical add is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME,
      address: ADDRESS,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with the default TTL written another way is still already_exists", async () => {
    // RouterOS stores the default TTL in its own form; 24h must match it.
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME,
      address: ADDRESS,
      ttl: "24h",
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with another address is a CONFLICT and leaves the record as it was", async () => {
    const error = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME,
      address: "192.0.2.11",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("DNS_ENTRY_CONFLICT");
    expect((await findOnRouter())!.address).toBe(ADDRESS);
  });

  it("add finds the record whatever the case of the name", async () => {
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: NAME.toUpperCase(),
      address: ADDRESS,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("remove picks one of several records by address", async () => {
    // add never creates a second record with one name, so make it directly.
    const SECOND = "192.0.2.12";
    await harness.context.routerClient.create("ip/dns/static", { name: NAME, address: SECOND });

    const ambiguous = await runTool(harness.context, "manage_dns_entry", {
      action: "remove",
      name: NAME,
    }).catch((err: unknown) => err);
    expect(ambiguous).toBeInstanceOf(MikroMCPError);
    expect((ambiguous as MikroMCPError).code).toBe("DNS_ENTRY_AMBIGUOUS");

    const removed = await runTool(harness.context, "manage_dns_entry", {
      action: "remove",
      name: NAME,
      address: SECOND,
    });
    expect(removed.structuredContent.action).toBe("removed");

    const left = await harness.context.routerClient.get<RouterOSRecord>("ip/dns/static", {
      filter: { name: NAME },
    });
    expect(left.map((r) => r.address)).toEqual([ADDRESS]);
  });

  it("an A record without an address is rejected before touching the router", async () => {
    const error = await runTool(harness.context, "manage_dns_entry", {
      action: "add",
      name: "other.mikromcp.invalid",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("DNS_MISSING_ADDRESS");
  });

  it("list_dns_entries finds the record by name filter", async () => {
    const result = await runTool(harness.context, "list_dns_entries", { name: "itest" });

    const entries = result.structuredContent.entries as RouterOSRecord[];
    expect(entries.map((e) => e.name)).toContain(NAME);
  });

  it("remove deletes the record", async () => {
    const result = await runTool(harness.context, "manage_dns_entry", {
      action: "remove",
      name: NAME,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing record throws NOT_FOUND", async () => {
    const error = await runTool(harness.context, "manage_dns_entry", {
      action: "remove",
      name: NAME,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("DNS_ENTRY_NOT_FOUND");
  });
});

describe("manage_dns_settings singleton write against live CHR", () => {
  // The DNS settings menu returns no ".id" — this covers the /set command
  // write path that a PATCH-by-id would break (it would hit ".../undefined").
  async function readUdpSize(): Promise<number> {
    const records = await harness.context.routerClient.get<RouterOSRecord>("ip/dns");
    return Number((records[0] as Record<string, unknown>)["max-udp-packet-size"]);
  }

  it("applies and reverts a max-udp-packet-size change", async () => {
    const original = await readUdpSize();
    const changed = original === 4096 ? 2048 : 4096;

    const applied = await runTool(harness.context, "manage_dns_settings", {
      maxUdpPacketSize: changed,
    });
    expect(applied.structuredContent.action).toBe("updated");
    expect(await readUdpSize()).toBe(changed);

    const reverted = await runTool(harness.context, "manage_dns_settings", {
      maxUdpPacketSize: original,
    });
    expect(reverted.structuredContent.action).toBe("updated");
    expect(await readUdpSize()).toBe(original);
  });

  it("an unchanged value is a no_change, not a phantom write", async () => {
    const original = await readUdpSize();
    const result = await runTool(harness.context, "manage_dns_settings", {
      maxUdpPacketSize: original,
    });
    expect(result.structuredContent.action).toBe("no_change");
  });
});

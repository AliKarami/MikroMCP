import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";

const harness = createHarness();

const ADDRESS = "192.0.2.1/24";
const IFACE = "ether1";

const { find: findOnRouter, removeLeftover } = liveResource(harness.context, "ip/address", {
  address: ADDRESS,
  interface: IFACE,
});

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_ip_address lifecycle against live CHR", () => {
  it("dry-run add does not touch the router", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "add",
      address: ADDRESS,
      interface: IFACE,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("add creates the address", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "add",
      address: ADDRESS,
      interface: IFACE,
    });

    expect(result.structuredContent.action).toBe("created");
    const onRouter = await findOnRouter();
    expect(onRouter).toBeDefined();
    expect(onRouter!.address).toBe(ADDRESS);
  });

  it("identical add is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "add",
      address: ADDRESS,
      interface: IFACE,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different config throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_ip_address", {
        action: "add",
        address: ADDRESS,
        interface: IFACE,
        comment: "different config",
      }),
    ).rejects.toMatchObject({ code: "IP_ADDRESS_CONFLICT" });
  });

  it("update changes the comment", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "update",
      address: ADDRESS,
      interface: IFACE,
      comment: "itest",
    });

    expect(result.structuredContent.action).toBe("updated");
    expect((await findOnRouter())!.comment).toBe("itest");
  });

  it("identical update reports no_change", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "update",
      address: ADDRESS,
      interface: IFACE,
      comment: "itest",
    });

    expect(result.structuredContent.action).toBe("no_change");
  });

  it("dry-run remove leaves the address in place", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "remove",
      address: ADDRESS,
      interface: IFACE,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeDefined();
  });

  it("remove deletes the address", async () => {
    const result = await runTool(harness.context, "manage_ip_address", {
      action: "remove",
      address: ADDRESS,
      interface: IFACE,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing address throws NOT_FOUND", async () => {
    const error = await runTool(harness.context, "manage_ip_address", {
      action: "remove",
      address: ADDRESS,
      interface: IFACE,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("IP_ADDRESS_NOT_FOUND");
  });
});

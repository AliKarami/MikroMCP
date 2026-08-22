import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, liveResource, runTool } from "./helpers/harness.js";
import { MikroMCPError } from "../../src/domain/errors/error-types.js";
import type { RouterOSRecord } from "../../src/types.js";

const harness = createHarness();

const DST = "198.51.100.0/24";
const GATEWAY = "192.0.2.254";

const { find: findOnRouter, removeLeftover } = liveResource(
  harness.context,
  "ip/route",
  { "dst-address": DST },
  (r) => r.gateway === GATEWAY || r["immediate-gw"] === GATEWAY,
);

beforeAll(removeLeftover);

afterAll(async () => {
  await removeLeftover();
  harness.close();
});

describe("manage_route lifecycle against live CHR", () => {
  it("dry-run add does not touch the router", async () => {
    const result = await runTool(harness.context, "manage_route", {
      action: "add",
      dstAddress: DST,
      gateway: GATEWAY,
      dryRun: true,
    });

    expect(result.structuredContent.action).toBe("dry_run");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("add creates the route", async () => {
    const result = await runTool(harness.context, "manage_route", {
      action: "add",
      dstAddress: DST,
      gateway: GATEWAY,
    });

    expect(result.structuredContent.action).toBe("created");
    expect(await findOnRouter()).toBeDefined();
  });

  it("identical add is idempotent (already_exists)", async () => {
    const result = await runTool(harness.context, "manage_route", {
      action: "add",
      dstAddress: DST,
      gateway: GATEWAY,
    });

    expect(result.structuredContent.action).toBe("already_exists");
  });

  it("add with a different distance throws CONFLICT", async () => {
    await expect(
      runTool(harness.context, "manage_route", {
        action: "add",
        dstAddress: DST,
        gateway: GATEWAY,
        distance: 5,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  });

  it("list_routes staticOnly includes the route", async () => {
    const result = await runTool(harness.context, "list_routes", { staticOnly: true });

    const routes = result.structuredContent.routes as RouterOSRecord[];
    expect(routes.map((r) => r["dst-address"])).toContain(DST);
  });

  it("remove deletes the route", async () => {
    const result = await runTool(harness.context, "manage_route", {
      action: "remove",
      dstAddress: DST,
      gateway: GATEWAY,
    });

    expect(result.structuredContent.action).toBe("removed");
    expect(await findOnRouter()).toBeUndefined();
  });

  it("removing a missing route throws NOT_FOUND", async () => {
    const error = await runTool(harness.context, "manage_route", {
      action: "remove",
      dstAddress: DST,
      gateway: GATEWAY,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MikroMCPError);
    expect((error as MikroMCPError).code).toBe("ROUTE_NOT_FOUND");
  });
});

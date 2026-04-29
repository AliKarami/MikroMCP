import { describe, it, expect, vi } from "vitest";
import { wifiTools } from "../../../src/domain/tools/wifi-tools.js";
import type { ToolContext } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";

function makeRouterConfig(rosVersion = "7"): RouterConfig {
  return {
    id: "test-router",
    host: "192.168.1.1",
    port: 443,
    tls: { enabled: true, rejectUnauthorized: false },
    credentials: { source: "env", envPrefix: "ROUTER_TEST" },
    tags: [],
    rosVersion,
  };
}

function makeContext(records: Record<string, unknown>[], rosVersion = "7"): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "corr",
    routerConfig: makeRouterConfig(rosVersion),
    credentials: { username: "admin", password: "secret" },
    routerClient: {
      get: vi.fn().mockResolvedValue(records),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as RouterOSRestClient,
  };
}

const [listWifiTool, listWifiClientsTool, manageWifiTool] = wifiTools;

describe("wifiTools", () => {
  describe("metadata", () => {
    it("exports 3 tools", () => expect(wifiTools).toHaveLength(3));
    it("list_wifi_interfaces is readOnly", () =>
      expect(listWifiTool.annotations.readOnlyHint).toBe(true));
    it("list_wifi_clients is readOnly", () =>
      expect(listWifiClientsTool.annotations.readOnlyHint).toBe(true));
    it("manage_wifi_interface is not readOnly", () =>
      expect(manageWifiTool.annotations.readOnlyHint).toBe(false));
  });

  describe("list_wifi_interfaces", () => {
    it("uses /interface/wifi for ROS 7", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", name: "wifi1", ssid: "MyNet", disabled: "false" }],
        "7",
      );
      await listWifiTool.handler({ routerId: "test-router" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith(
        "interface/wifi",
        expect.anything(),
      );
    });

    it("uses /interface/wireless for ROS 6", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", name: "wlan1", ssid: "MyNet", disabled: "false" }],
        "6",
      );
      await listWifiTool.handler({ routerId: "test-router" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith(
        "interface/wireless",
        expect.anything(),
      );
    });

    it("returns interfaces in structuredContent", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "wifi1", ssid: "MyNet", disabled: "false" }]);
      const result = await listWifiTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.interfaces as unknown[]).length).toBe(1);
    });
  });

  describe("list_wifi_clients", () => {
    it("uses /interface/wifi/registration-table for ROS 7", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:FF", interface: "wifi1" }],
        "7",
      );
      await listWifiClientsTool.handler({ routerId: "test-router" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith(
        "interface/wifi/registration-table",
        expect.anything(),
      );
    });

    it("uses /interface/wireless/registration-table for ROS 6", async () => {
      const ctx = makeContext(
        [{ ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:FF", interface: "wlan1" }],
        "6",
      );
      await listWifiClientsTool.handler({ routerId: "test-router" }, ctx);
      expect(ctx.routerClient.get).toHaveBeenCalledWith(
        "interface/wireless/registration-table",
        expect.anything(),
      );
    });

    it("returns clients in structuredContent", async () => {
      const ctx = makeContext([
        { ".id": "*1", "mac-address": "AA:BB:CC:DD:EE:FF", interface: "wifi1" },
      ]);
      const result = await listWifiClientsTool.handler({ routerId: "test-router" }, ctx);
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.clients as unknown[]).length).toBe(1);
    });
  });

  describe("manage_wifi_interface - dry run", () => {
    it("returns dry_run without calling update", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "wifi1", disabled: "false", ssid: "OldNet" }]);
      const result = await manageWifiTool.handler(
        {
          routerId: "test-router",
          name: "wifi1",
          ssid: "NewNet",
          dryRun: true,
        },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("dry_run");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("manage_wifi_interface - validation", () => {
    it("throws VALIDATION when no changes specified", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "wifi1", disabled: "false" }]);
      await expect(
        manageWifiTool.handler({ routerId: "test-router", name: "wifi1" }, ctx),
      ).rejects.toThrow("At least one of");
    });
  });

  describe("manage_wifi_interface - not found", () => {
    it("throws NOT_FOUND when interface is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        manageWifiTool.handler(
          { routerId: "test-router", name: "wifi1", disabled: false },
          ctx,
        ),
      ).rejects.toThrow("not found");
    });
  });

  describe("manage_wifi_interface - no_change", () => {
    it("returns no_change when config already matches", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "wifi1", disabled: "false", ssid: "MyNet" }]);
      const result = await manageWifiTool.handler(
        { routerId: "test-router", name: "wifi1", ssid: "MyNet", disabled: false },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("no_change");
      expect(ctx.routerClient.update).not.toHaveBeenCalled();
    });
  });

  describe("manage_wifi_interface - updated", () => {
    it("calls update and returns updated action", async () => {
      const ctx = makeContext([{ ".id": "*1", name: "wifi1", disabled: "false", ssid: "OldNet" }]);
      const result = await manageWifiTool.handler(
        { routerId: "test-router", name: "wifi1", ssid: "NewNet", dryRun: false },
        ctx,
      );
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("updated");
      expect(ctx.routerClient.update).toHaveBeenCalledWith(
        "interface/wifi",
        "*1",
        { ssid: "NewNet" },
      );
    });
  });
});

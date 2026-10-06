import { describe, it, expect, vi } from "vitest";
import { ipTools } from "../../../src/domain/tools/ip-tools.js";
import { bridgeTools } from "../../../src/domain/tools/bridge-tools.js";
import { interfaceListTools } from "../../../src/domain/tools/interface-list-tools.js";
import type { ToolContext, ToolDefinition } from "../../../src/domain/tools/tool-definition.js";
import type { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import { fromWire, type WireRecord } from "../helpers/wire.js";

function makeContext(rows: WireRecord[]): ToolContext {
  return {
    routerId: "test-router",
    correlationId: "test-corr",
    routerClient: {
      get: vi.fn().mockResolvedValue(fromWire(rows)),
    } as unknown as RouterOSRestClient,
  } as unknown as ToolContext;
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  return tools.find((t) => t.name === name)!;
}

/** Paginated list tools added in 1.12.0, with the structuredContent key of their rows. */
const cases: Array<{ tool: ToolDefinition; key: string; rows: WireRecord[] }> = [
  {
    tool: tool(ipTools, "list_ip_addresses"),
    key: "addresses",
    rows: [
      { ".id": "*1", address: "192.168.1.1/24", interface: "bridge1", disabled: "false" },
      { ".id": "*2", address: "10.0.0.1/24", interface: "ether2", disabled: "false" },
    ],
  },
  {
    tool: tool(bridgeTools, "list_bridge_ports"),
    key: "ports",
    rows: [
      { ".id": "*0", bridge: "bridge1", interface: "ether1", pvid: "1" },
      { ".id": "*7", bridge: "bridge1", interface: "wifi1", pvid: "1" },
    ],
  },
  {
    tool: tool(interfaceListTools, "list_interface_list_members"),
    key: "members",
    rows: [
      { ".id": "*A", list: "WAN", interface: "ether1", dynamic: "false" },
      { ".id": "*B", list: "LAN", interface: "bridge1", dynamic: "false" },
    ],
  },
];

describe.each(cases)("$tool.name pagination edges", ({ tool, key, rows }) => {
  async function run(params: Record<string, unknown>, data = rows) {
    const result = await tool.handler({ routerId: "test-router", ...params }, makeContext(data));
    return result.structuredContent as Record<string, unknown>;
  }

  it("returns an empty page with hasMore false when offset is past the end", async () => {
    const sc = await run({ offset: 10 });
    expect(sc[key]).toEqual([]);
    expect(sc.total).toBe(2);
    expect(sc.hasMore).toBe(false);
  });

  it("returns an empty result when the router has no records", async () => {
    const sc = await run({}, []);
    expect(sc[key]).toEqual([]);
    expect(sc.total).toBe(0);
    expect(sc.hasMore).toBe(false);
  });

  it("accepts limit 500 and rejects 501", async () => {
    const sc = await run({ limit: 500 });
    expect(sc[key]).toHaveLength(2);
    expect(sc.limit).toBe(500);
    expect(tool.inputSchema.safeParse({ routerId: "r", limit: 501 }).success).toBe(false);
  });

  it("reports hasMore when the page ends before the last record", async () => {
    const sc = await run({ limit: 1 });
    expect(sc[key]).toHaveLength(1);
    expect(sc.hasMore).toBe(true);
  });
});

describe("list_bridge_ports without debug-info", () => {
  it("returns a record that has no debug-info unchanged", async () => {
    const row = { ".id": "*7", bridge: "bridge1", interface: "wifi1", pvid: "1" };
    const result = await tool(bridgeTools, "list_bridge_ports").handler(
      { routerId: "test-router" },
      makeContext([row]),
    );
    const ports = (result.structuredContent as Record<string, unknown>).ports;
    expect(ports).toEqual(fromWire([row]));
  });
});

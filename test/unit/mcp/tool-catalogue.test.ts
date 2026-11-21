import { describe, it, expect } from "vitest";
import { allTools, toolsets, ALWAYS_ON_TOOLS } from "../../../src/domain/tools/index.js";
import {
  assertKnownToolsets,
  catalogueNote,
  selectCatalogue,
  toolsForIdentity,
  toolsetNames,
} from "../../../src/mcp/tool-catalogue.js";
import { MikroMCPError } from "../../../src/domain/errors/error-types.js";
import type { Identity } from "../../../src/types.js";

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

describe("toolsets", () => {
  it("puts every tool in exactly one toolset", () => {
    const counts = new Map<string, number>();
    for (const tools of Object.values(toolsets)) {
      for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
    expect(duplicated).toEqual([]);
    expect(counts.size).toBe(allTools.length);
  });

  it("uses lowercase names, as MIKROMCP_TOOLSETS is lowercased", () => {
    for (const name of toolsetNames()) expect(name).toMatch(/^[a-z]+$/);
  });

  it("always-on tools exist", () => {
    for (const name of ALWAYS_ON_TOOLS) expect(names(allTools)).toContain(name);
  });
});

describe("selectCatalogue", () => {
  it("returns every tool by default", () => {
    expect(selectCatalogue({ readOnly: false, toolsets: [] })).toHaveLength(allTools.length);
  });

  it("read-only keeps only readOnlyHint tools, and some of each kind exist", () => {
    const tools = selectCatalogue({ readOnly: true, toolsets: [] });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(allTools.length);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(names(tools)).not.toContain("manage_firewall_rule");
    expect(names(tools)).not.toContain("bulk_execute");
    expect(names(tools)).not.toContain("apply_plan");
    expect(names(tools)).toContain("list_firewall_rules");
  });

  it("toolsets keep their tools plus the always-on ones", () => {
    const tools = names(selectCatalogue({ readOnly: false, toolsets: ["firewall"] }));
    expect(tools).toEqual(
      expect.arrayContaining([...names(toolsets.firewall), ...ALWAYS_ON_TOOLS]),
    );
    expect(tools).toHaveLength(toolsets.firewall.length + ALWAYS_ON_TOOLS.size);
    expect(tools).not.toContain("list_routes");
  });

  it("read-only and toolsets compose", () => {
    const tools = selectCatalogue({ readOnly: true, toolsets: ["firewall", "dhcp"] });
    expect(names(tools)).toContain("list_firewall_rules");
    expect(names(tools)).toContain("list_dhcp_leases");
    expect(names(tools)).not.toContain("manage_dhcp_lease");
  });
});

describe("assertKnownToolsets", () => {
  it("accepts known names", () => {
    expect(() => assertKnownToolsets(["firewall", "fleet"])).not.toThrow();
  });

  it("names the unknown and the valid toolsets", () => {
    try {
      assertKnownToolsets(["firewall", "firewal"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MikroMCPError);
      expect((err as MikroMCPError).code).toBe("UNKNOWN_TOOLSET");
      expect((err as MikroMCPError).message).toContain("firewal");
      expect((err as MikroMCPError).message).toContain("routing");
    }
  });
});

describe("toolsForIdentity", () => {
  const identity = (patterns: string[]): Identity =>
    ({ id: "x", role: "readonly", allowedRouters: [], allowedToolPatterns: patterns }) as Identity;

  it("keeps everything without an identity or without patterns", () => {
    expect(toolsForIdentity(allTools, undefined)).toHaveLength(allTools.length);
    expect(toolsForIdentity(allTools, identity([]))).toHaveLength(allTools.length);
  });

  it("keeps only the tools the patterns match", () => {
    const tools = names(toolsForIdentity(allTools, identity(["list_*", "ping"])));
    expect(tools.every((n) => n.startsWith("list_") || n === "ping")).toBe(true);
    expect(tools).toContain("ping");
    expect(tools).not.toContain("manage_route");
  });
});

describe("catalogueNote", () => {
  it("is undefined for the full catalogue", () => {
    expect(catalogueNote({ readOnly: false, toolsets: [] })).toBeUndefined();
  });

  it("names the mode and toolsets", () => {
    const note = catalogueNote({ readOnly: true, toolsets: ["firewall"] });
    expect(note).toMatch(/read-only/);
    expect(note).toMatch(/firewall/);
  });
});

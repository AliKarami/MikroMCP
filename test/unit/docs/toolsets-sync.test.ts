import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { toolsetNames } from "../../../src/mcp/tool-catalogue.js";

const page = readFileSync("docs/wiki/Configuration.md", "utf-8");

describe("Configuration.md toolset table", () => {
  it("lists exactly the toolsets MIKROMCP_TOOLSETS accepts", () => {
    const section = page.slice(page.indexOf("| Toolset | Contains |"));
    const table = section.slice(0, section.indexOf("\n\n"));
    const documented = [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(toolsetNames().sort());
  });
});

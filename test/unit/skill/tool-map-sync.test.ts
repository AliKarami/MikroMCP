import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const MAP_PATH = join(process.cwd(), "skills/mikromcp/references/tool-map.md");

/** Tool names referenced in the map: any `code` span that matches a real tool name shape. */
function toolNamesInMap(markdown: string): Set<string> {
  const names = new Set<string>();
  const codeSpan = /`([a-z][a-z0-9_]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = codeSpan.exec(markdown)) !== null) {
    names.add(m[1]);
  }
  return names;
}

describe("skill tool-map stays in lockstep with allTools", () => {
  const markdown = readFileSync(MAP_PATH, "utf-8");
  const mapped = toolNamesInMap(markdown);
  const real = new Set(allTools.map((t) => t.name));

  it("every tool in allTools is documented in tool-map.md", () => {
    const missing = [...real].filter((name) => !mapped.has(name)).sort();
    expect(missing, `tools missing from tool-map.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("every tool name referenced in tool-map.md exists in allTools", () => {
    // Only check tokens that look like tool names (verb_noun); ignore RouterOS
    // paths and field names by requiring an underscore and a known verb prefix.
    const verbs = ["list", "get", "manage", "create", "export", "run", "set", "ping", "traceroute", "torch", "reboot", "rollback", "plan", "apply", "bulk", "check", "upload"];
    const referencedTools = [...mapped].filter((n) =>
      verbs.some((v) => n === v || n.startsWith(v + "_")),
    );
    const unknown = referencedTools.filter((name) => !real.has(name)).sort();
    expect(unknown, `unknown tool names in tool-map.md: ${unknown.join(", ")}`).toEqual([]);
  });
});

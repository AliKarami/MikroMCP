import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const DOC = join(process.cwd(), "docs/wiki/Available-Tools.md");

/** Tool names are documented as headers: `### `tool_name` — Class`. */
function documentedTools(markdown: string): Set<string> {
  const names = new Set<string>();
  const header = /^#{2,4}\s+`([a-z0-9_]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = header.exec(markdown)) !== null) names.add(m[1]);
  return names;
}

describe("Available-Tools.md stays in lockstep with allTools", () => {
  const markdown = readFileSync(DOC, "utf-8");
  const documented = documentedTools(markdown);
  const real = new Set(allTools.map((t) => t.name));

  it("documents every tool in allTools", () => {
    const missing = [...real].filter((n) => !documented.has(n)).sort();
    expect(missing, `tools missing from Available-Tools.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents no tool that does not exist", () => {
    const unknown = [...documented].filter((n) => !real.has(n)).sort();
    expect(unknown, `unknown tools in Available-Tools.md: ${unknown.join(", ")}`).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const COUNT = allTools.length;

/**
 * Files that state the *current* tool count. Roadmap files are excluded on purpose:
 * their counts are historical statements about past releases ("99 → 117 tools").
 */
const FILES = [
  "README.md",
  "docs/wiki/Home.md",
  "docs/wiki/Architecture.md",
  "docs/wiki/Available-Tools.md",
  "docs/wiki/Connecting-to-AI-Assistants.md",
  "docs/wiki/Development.md",
  "docs/wiki/Getting-Started.md",
  "docs/wiki/RouterOS-API-Setup.md",
  "docs-site/astro.config.mjs",
  "site/src/data/content.ts",
];

/**
 * Collect stated tool counts: prose ("N tools", "N typed tools", "N MCP tools",
 * "N MikroMCP tools", "N typed, auditable tools"), the README badge ("tools-N"),
 * and the landing page's `toolCount: N`.
 */
function statedCounts(text: string): number[] {
  const patterns = [
    /\b(\d+)\s+(?:typed\s+|MCP\s+|MikroMCP\s+|typed,\s*auditable\s+)?tools\b/gi,
    /tools-(\d+)/gi,
    /toolCount:\s*(\d+)/g,
  ];
  const counts: number[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) counts.push(Number(m[1]));
  }
  return counts;
}

describe("stated tool count matches allTools.length", () => {
  for (const file of FILES) {
    it(`${file} states ${COUNT} consistently`, () => {
      const text = readFileSync(join(process.cwd(), file), "utf-8");
      const counts = statedCounts(text);
      expect(counts.length, `no tool count found in ${file}`).toBeGreaterThan(0);
      const wrong = counts.filter((c) => c !== COUNT);
      expect(wrong, `${file} states tool counts != ${COUNT}: ${wrong.join(", ")}`).toEqual([]);
    });
  }
});

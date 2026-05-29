import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "../../../src/domain/tools/index.js";

const COUNT = allTools.length;
const FILES = ["README.md", "docs/wiki/Home.md", "docs/wiki/Architecture.md"];

/** Collect stated tool counts: prose ("N tools", "N typed tools", "N MCP tools") and the README badge ("tools-N"). */
function statedCounts(markdown: string): number[] {
  const counts: number[] = [];
  const prose = /\b(\d+)\s+(?:typed\s+|MCP\s+)?tools\b/gi;
  const badge = /tools-(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = prose.exec(markdown)) !== null) counts.push(Number(m[1]));
  while ((m = badge.exec(markdown)) !== null) counts.push(Number(m[1]));
  return counts;
}

describe("stated tool count matches allTools.length", () => {
  for (const file of FILES) {
    it(`${file} states ${COUNT} consistently`, () => {
      const markdown = readFileSync(join(process.cwd(), file), "utf-8");
      const counts = statedCounts(markdown);
      expect(counts.length, `no tool count found in ${file}`).toBeGreaterThan(0);
      const wrong = counts.filter((c) => c !== COUNT);
      expect(wrong, `${file} states tool counts != ${COUNT}: ${wrong.join(", ")}`).toEqual([]);
    });
  }
});

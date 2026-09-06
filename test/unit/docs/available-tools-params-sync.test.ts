import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { allTools } from "../../../src/domain/tools/index.js";

const DOC = join(process.cwd(), "docs/wiki/Available-Tools.md");

/**
 * Parameter names each tool's section documents, keyed by tool name. A section
 * starts at a `### `tool_name`` header and runs to the next header of any
 * level; its parameter table lists one parameter per row as `| `name` | ...`.
 */
function documentedParams(markdown: string): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>();
  const header = /^#{2,4}\s+`([a-z0-9_]+)`[^\n]*\n([\s\S]*?)(?=^#{2,4}\s|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = header.exec(markdown)) !== null) {
    const params = new Set<string>();
    for (const row of m[2].matchAll(/^\|\s*`([A-Za-z0-9_]+)`\s*\|/gm)) params.add(row[1]);
    sections.set(m[1], params);
  }
  return sections;
}

/** Top-level input parameter names, looking through refinements and wrappers. */
function schemaParams(schema: z.ZodTypeAny): Set<string> {
  let s: z.ZodTypeAny = schema;
  for (;;) {
    if (s instanceof z.ZodEffects) s = s._def.schema as z.ZodTypeAny;
    else if (s instanceof z.ZodDefault || s instanceof z.ZodOptional)
      s = s._def.innerType as z.ZodTypeAny;
    else break;
  }
  if (!(s instanceof z.ZodObject)) {
    throw new Error(`unsupported input schema type ${s.constructor.name}`);
  }
  return new Set(Object.keys(s.shape as Record<string, unknown>));
}

describe("Available-Tools.md parameter tables stay in lockstep with input schemas", () => {
  const documented = documentedParams(readFileSync(DOC, "utf-8"));

  for (const tool of allTools) {
    it(`${tool.name} documents exactly its schema parameters`, () => {
      const doc = documented.get(tool.name);
      expect(doc, `no section for ${tool.name}`).toBeDefined();
      const real = schemaParams(tool.inputSchema);
      const missing = [...real].filter((p) => !doc!.has(p)).sort();
      const stale = [...doc!].filter((p) => !real.has(p)).sort();
      expect(missing, `parameters missing from the ${tool.name} table`).toEqual([]);
      expect(stale, `parameters in the ${tool.name} table that the schema does not accept`).toEqual(
        [],
      );
    });
  }
});

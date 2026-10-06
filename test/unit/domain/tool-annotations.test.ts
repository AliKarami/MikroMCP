import { describe, it, expect } from "vitest";
import { allTools } from "../../../src/domain/tools/index.js";

// MCP defines destructiveHint: false as "performs only additive updates", and the
// confirmation gate and maintenance windows key off it. A write tool that can
// remove, overwrite, reconfigure, or run RouterOS script is therefore destructive.
// List a tool here only if it cannot change existing router state.
const ADDITIVE_WRITE_TOOLS = new Set(["plan_changes"]);

describe("tool annotations", () => {
  it("marks every write tool destructive unless it is purely additive", () => {
    const offenders = allTools
      .filter((t) => !t.annotations.readOnlyHint && !t.annotations.destructiveHint)
      .map((t) => t.name)
      .filter((name) => !ADDITIVE_WRITE_TOOLS.has(name))
      .sort();
    expect(
      offenders,
      `write tools marked non-destructive: ${offenders.join(", ")} — set destructiveHint: true, or add to ADDITIVE_WRITE_TOOLS if the tool cannot change existing router state`,
    ).toEqual([]);
  });

  it("lists only existing, non-destructive write tools as additive", () => {
    for (const name of ADDITIVE_WRITE_TOOLS) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool, `${name} is not a registered tool`).toBeDefined();
      expect(tool!.annotations.readOnlyHint).toBe(false);
      expect(tool!.annotations.destructiveHint).toBe(false);
    }
  });

  it("marks tools that run RouterOS script destructive", () => {
    const scriptRunners = [
      "run_command",
      "run_script",
      "manage_script",
      "manage_scheduled_job",
      "upload_file",
    ];
    for (const name of scriptRunners) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool?.annotations.destructiveHint, name).toBe(true);
    }
  });
});

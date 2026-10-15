import { describe, it, expect } from "vitest";
import { allTools } from "../../../src/domain/tools/index.js";

// MCP defines destructiveHint: false as "performs only additive updates", and the
// confirmation gate and maintenance windows key off it. A write tool that can
// remove, overwrite, reconfigure, or run RouterOS script is therefore destructive.
// List a tool here only if it cannot change existing router state.
// save_swos_backup writes a file on the server and nothing on the switch.
const ADDITIVE_WRITE_TOOLS = new Set(["plan_changes", "save_swos_backup"]);

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

  it("states whether each SwOS config and maintenance tool is idempotent", () => {
    const expected: Record<string, boolean> = {
      get_swos_config: true, // a read
      apply_swos_config: true, // the same document applied twice changes nothing the second time
      save_swos_backup: false, // every call writes another file
      restore_swos_backup: false, // the switch reboots each time
      upgrade_swos_firmware: true, // the same version a second time is a no-op
      set_swos_password: false, // the second call runs with the old password already replaced
    };
    for (const [name, idempotent] of Object.entries(expected)) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool, `${name} is not a registered tool`).toBeDefined();
      expect(tool!.annotations.idempotentHint, name).toBe(idempotent);
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
